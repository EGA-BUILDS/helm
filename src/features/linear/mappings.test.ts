import { describe, expect, it } from "vitest";
import {
  createLinearMappingsAdapter,
  decodeCandidates,
  decodeMapping,
  toMappingError,
  type FetchLike,
} from "./mappings";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const mappingWire = {
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
  startedStateId: "state-started",
  startedStateName: "In Progress",
  enabled: true,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

describe("linear mappings adapter", () => {
  it("decodes a saved mapping with baseRef and targetBranch intact", () => {
    const decoded = decodeMapping(mappingWire);
    expect(decoded.worktreeBaseRef).toBe("refs/heads/release");
    expect(decoded.targetBranch).toBe("main");
    expect(decoded.startedStateName).toBe("In Progress");
  });

  it("rejects a malformed mapping instead of defaulting", () => {
    expect(() => decodeMapping({ ...mappingWire, targetBranch: 42 })).toThrow(/target branch/i);
    expect(() => decodeMapping(null)).toThrow(/project mapping/i);
  });

  it("decodes candidates with per-team started states and state errors", () => {
    const decoded = decodeCandidates({
      workspace: { workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm" },
      projects: [{
        projectId: "proj-1",
        projectName: "Helm",
        teams: [
          { teamId: "t-eng", teamKey: "ENG", teamName: "Engineering", startedStateId: "s-1", startedStateName: "In Progress", stateError: null },
          { teamId: "t-ops", teamKey: "OPS", teamName: "Operations", startedStateId: null, startedStateName: null, stateError: "Linear team OPS has no started workflow state" },
        ],
      }],
      t3: { connections: [{ connectionId: "c-1", environmentId: "env-1", status: "connected", projects: [{ projectId: "p-1", title: "Native" }], truncated: false, error: null }] },
      truncated: false,
    });
    expect(decoded.projects[0]?.teams).toHaveLength(2);
    expect(decoded.projects[0]?.teams[0]).toMatchObject({ startedStateId: "s-1", stateError: null });
    expect(decoded.projects[0]?.teams[1]?.stateError).toMatch(/no started workflow state/);
  });

  it("lists, saves, and disables through the same-origin routes", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input === "/api/linear/mappings") {
        return init?.method === "POST" ? response(200, { mapping: mappingWire }) : response(200, { mappings: [mappingWire] });
      }
      if (input === "/api/linear/mappings/candidates") {
        return response(200, {
          workspace: { workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm" },
          projects: [], t3: { connections: [] }, truncated: false,
        });
      }
      return response(200, { mappingId: "m-1", status: "disabled" });
    };
    const adapter = createLinearMappingsAdapter(fetchImpl);
    await expect(adapter.listMappings()).resolves.toHaveLength(1);
    await expect(adapter.saveMapping({
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId: "c-1", t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1",
      t3ProjectTitle: "Helm native", worktreeBaseRef: "refs/heads/release", targetBranch: "main",
    })).resolves.toMatchObject({ mappingId: "m-1" });
    await expect(adapter.loadCandidates()).resolves.toMatchObject({ workspace: { workspaceId: "ws-1" } });
    await expect(adapter.disableMapping("m-1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "GET /api/linear/mappings",
      "POST /api/linear/mappings",
      "GET /api/linear/mappings/candidates",
      "DELETE /api/linear/mappings/m-1",
    ]);
  });

  it("maps anonymous and validation failures to explicit error states", async () => {
    const denied: FetchLike = async () => response(401, { error: { code: "access_denied", message: "nope" } });
    await expect(createLinearMappingsAdapter(denied).listMappings()).rejects.toMatchObject({ mappingError: { code: "access_denied" } });
    const invalid: FetchLike = async () => response(400, { error: { code: "invalid_request", message: "bad" } });
    await expect(createLinearMappingsAdapter(invalid).listMappings()).rejects.toMatchObject({ mappingError: { code: "invalid_request", retryable: false } });
  });

  it("treats a 2xx body that misses the projection as an error", async () => {
    const empty: FetchLike = async () => response(200, { mappings: null });
    await expect(createLinearMappingsAdapter(empty).listMappings()).rejects.toThrow(/mapping inventory/i);
  });

  it("sanitizes unknown failures without leaking upstream text", () => {
    expect(toMappingError(new Error("boom"))).toMatchObject({ code: "unknown", retryable: true });
  });
});
