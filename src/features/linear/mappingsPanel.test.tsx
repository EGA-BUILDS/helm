import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MappingsView } from "./MappingsPanel";
import type { MappingCandidates, ProjectMapping } from "./mappings";

const mapping: ProjectMapping = {
  mappingId: "m-1",
  linearWorkspaceId: "ws-1",
  linearProjectId: "proj-1",
  linearProjectName: "Helm",
  linearTeamId: "team-eng",
  linearTeamKey: "ENG",
  linearTeamName: "Engineering",
  t3ConnectionId: "c-1",
  t3EnvironmentId: "env-1",
  t3ProjectId: "t3-proj-1",
  t3ProjectTitle: "Helm native",
  worktreeBaseRef: "refs/heads/release",
  targetBranch: "main",
  startedStateId: "s-1",
  startedStateName: "In Progress",
  enabled: true,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

const candidates: MappingCandidates = {
  workspace: { workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm" },
  projects: [{
    projectId: "proj-1",
    projectName: "Helm",
    teams: [
      { teamId: "team-eng", teamKey: "ENG", teamName: "Engineering", startedStateId: "s-1", startedStateName: "In Progress", stateError: null },
      { teamId: "team-ops", teamKey: "OPS", teamName: "Operations", startedStateId: null, startedStateName: null, stateError: "Linear team OPS has no started workflow state" },
    ],
  }],
  t3: {
    connections: [{
      connectionId: "c-1", environmentId: "env-1", status: "connected",
      projects: [{ projectId: "t3-proj-1", title: "Helm native" }], truncated: false, error: null,
    }],
  },
  truncated: false,
};

function render(data: Parameters<typeof MappingsView>[0]["data"], error: Parameters<typeof MappingsView>[0]["error"] = null) {
  return renderToStaticMarkup(createElement(MappingsView, {
    data, notice: null, error, busy: null, onSave: () => undefined, onDisable: () => undefined,
  }));
}

describe("linear mappings view", () => {
  it("lists saved mappings with baseRef and targetBranch shown separately", () => {
    const html = render({ mappings: [mapping], mappingsError: null, candidates, candidatesError: null });
    expect(html).toContain("Helm · ENG");
    expect(html).toContain("refs/heads/release");
    expect(html).toContain("main");
    expect(html).toContain("In Progress");
    expect(html).toContain("Enabled");
  });

  it("marks disabled mappings without rewriting their identifiers", () => {
    const html = render({
      mappings: [{ ...mapping, mappingId: "m-2", enabled: false }],
      mappingsError: null, candidates, candidatesError: null,
    });
    expect(html).toContain("Disabled");
    expect(html).toContain("team-eng");
    expect(html).toContain("t3-proj-1");
  });

  it("surfaces mapping load failures as explicit error states", () => {
    const html = render(
      { mappings: null, mappingsError: { code: "unknown", message: "The project mappings request could not be completed.", retryable: true }, candidates, candidatesError: null },
    );
    expect(html).toContain("could not be completed");
  });

  it("explains the save requirements and offers live candidates", () => {
    const html = render({ mappings: [], mappingsError: null, candidates, candidatesError: null });
    expect(html).toContain("No mappings saved yet");
    expect(html).toContain("Select a Linear project");
    expect(html).toContain("Worktree baseRef");
    expect(html).toContain("PR target branch");
  });

  it("renders an action error without touching the saved list", () => {
    const onSave = vi.fn();
    const html = renderToStaticMarkup(createElement(MappingsView, {
      data: { mappings: [mapping], mappingsError: null, candidates, candidatesError: null },
      notice: null,
      error: { code: "invalid_request", message: "That mapping request was invalid.", retryable: false },
      busy: null, onSave, onDisable: () => undefined,
    }));
    expect(html).toContain("That mapping request was invalid.");
    expect(html).toContain("Helm · ENG");
  });
});
