/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  parseLinearProjects,
  parseLinearTeamStates,
  resolveStartedState,
  type LinearWorkflowState,
} from "./linearGraphql";

/**
 * Linear GraphQL parsing and started-state resolution contract (EGA-760).
 *
 * No network, no credentials: every case feeds a canned payload into the pure
 * parsers. Fail-closed behavior under test: GraphQL `errors`, malformed
 * shapes, a wrong workspace, and zero/multiple `started` states all throw
 * with a specific reason instead of returning a guess.
 */
describe("Linear GraphQL project and state parsing", () => {
  const workspace = { id: "ws-1" };
  const projectPayload = (projects: unknown[]) => ({
    data: { organization: { ...workspace }, projects: { nodes: projects } },
  });
  const teamPayload = (team: unknown) => ({ data: { team } });
  const state = (id: string, type: string): LinearWorkflowState => ({ id, name: `state-${id}`, type });

  it("parses projects with the teams that appear on issues", () => {
    expect(parseLinearProjects(projectPayload([
      { id: "p-1", name: "Helm", teams: { nodes: [{ id: "t-1", key: "ENG", name: "Engineering" }] } },
    ]), "ws-1")).toEqual([
      { id: "p-1", name: "Helm", teams: [{ id: "t-1", key: "ENG", name: "Engineering" }] },
    ]);
  });

  it("fails closed on GraphQL errors and malformed payloads", () => {
    expect(() => parseLinearProjects({ errors: [{ message: "boom" }] }, "ws-1")).toThrow(/reported errors/i);
    expect(() => parseLinearProjects({ data: null }, "ws-1")).toThrow(/unavailable/i);
    expect(() => parseLinearProjects(projectPayload([{ id: "", name: "x", teams: { nodes: [] } }]), "ws-1")).toThrow(/unavailable/i);
    expect(() => parseLinearProjects(projectPayload([{ id: "p", name: "x", teams: { nodes: [{ id: "t", key: "", name: "n" }] } }]), "ws-1")).toThrow(/unavailable/i);
  });

  it("fails closed when the response belongs to a different workspace", () => {
    expect(() => parseLinearProjects(projectPayload([]), "ws-other")).toThrow(/workspace identity changed/i);
    expect(() => parseLinearProjects({ data: { projects: { nodes: [] } } }, "ws-1")).toThrow(/workspace identity changed/i);
  });

  it("parses a team's states and rejects a mismatched team or workspace", () => {
    const payload = teamPayload({
      id: "t-1", key: "ENG", name: "Engineering",
      organization: { id: "ws-1" },
      states: { nodes: [{ id: "s-1", name: "In Progress", type: "started" }] },
    });
    expect(parseLinearTeamStates(payload, "t-1", "ws-1")).toEqual({
      team: { id: "t-1", key: "ENG", name: "Engineering" },
      states: [{ id: "s-1", name: "In Progress", type: "started" }],
    });
    expect(() => parseLinearTeamStates(payload, "t-other", "ws-1")).toThrow(/different team/i);
    expect(() => parseLinearTeamStates(payload, "t-1", "ws-other")).toThrow(/workspace identity changed/i);
    expect(() => parseLinearTeamStates(teamPayload(null), "t-1", "ws-1")).toThrow(/unavailable/i);
    expect(() => parseLinearTeamStates({ errors: [{ message: "nope" }] }, "t-1", "ws-1")).toThrow(/reported errors/i);
  });

  it("resolves the single usable started state for a team", () => {
    const states = [state("backlog", "backlog"), state("in-progress", "started"), state("done", "completed")];
    expect(resolveStartedState(states, "ENG")).toEqual({ id: "in-progress", name: "state-in-progress", type: "started" });
  });

  it("fails closed with a specific reason on zero started states", () => {
    expect(() => resolveStartedState([state("b", "backlog"), state("d", "completed")], "ENG"))
      .toThrow(/ENG.*no started workflow state/i);
  });

  it("fails closed with a specific reason on more than one started state", () => {
    expect(() => resolveStartedState([state("a", "started"), state("b", "started")], "ENG"))
      .toThrow(/ENG.*more than one started workflow state/i);
  });

  it("never considers non-started types as candidates", () => {
    expect(() => resolveStartedState(
      [state("a", "backlog"), state("b", "unstarted"), state("c", "completed"), state("d", "canceled")], "ENG",
    )).toThrow(/no started workflow state/i);
  });
});
