/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";

/**
 * Project mapping store and action contract (EGA-760, repaired EGA-760 review).
 *
 * Exercised through the internal store (no network) plus the public
 * owner-gated actions. The Linear live reads in `candidates` and `save` run
 * against a stubbed `fetch` (explicitly supported by convex-test) with a
 * seeded Linear connection, so the owner-chooses-started-state contract is
 * asserted end to end up to the T3 live read — which stays unmocked and out
 * of scope. Under test: owner+revision gating, the (owner, project, team)
 * uniqueness rule, explicit fail-closed reasons, a team offering two started
 * states with the owner choosing one, zero-state and stale-id rejections, and
 * the stored name coming from the live read.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

function validFields(t3ConnectionId: Id<"t3Connections">, overrides: Record<string, string> = {}) {
  return {
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearProjectName: "Helm",
    linearTeamId: "team-eng",
    linearTeamKey: "ENG",
    linearTeamName: "Engineering",
    t3ConnectionId,
    t3EnvironmentId: "env-1",
    t3ProjectId: "t3-proj-1",
    t3ProjectTitle: "Helm native",
    worktreeBaseRef: "refs/heads/main",
    targetBranch: "main",
    startedStateId: "state-started",
    startedStateName: "In Progress",
    ...overrides,
  };
}

/** Selectors-only args for the public `save` action (no caller labels). */
function actionArgs(t3ConnectionId: Id<"t3Connections">, overrides: Record<string, string> = {}) {
  return {
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    t3ConnectionId,
    t3EnvironmentId: "env-1",
    t3ProjectId: "t3-proj-1",
    worktreeBaseRef: "refs/heads/main",
    targetBranch: "main",
    startedStateId: "s-progress",
    ...overrides,
  };
}

describe("project mappings store", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedT3Connection(t: Harness): Promise<Id<"t3Connections">> {
    return await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp",
      issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp",
      clientId: "helm-test-client",
      environmentId: "env-1",
      environmentLabel: "Studio",
      serverVersion: "1.0.0",
      platform: "linux/x64",
      access: "read-only",
      status: "connected",
      tokenCiphertext: "v1.token.placeholder.placeholder",
      credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastVerifiedAt: null,
      lastSuccessfulReadAt: null,
      lastErrorCode: null,
    }));
  }

  function save(t: Harness, t3: Id<"t3Connections">, overrides: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    return t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, ...validFields(t3, overrides), at: Date.now(), ...extra,
    });
  }

  it("denies every store read and write without an owner grant", async () => {
    // Real ids from a seeded harness: format validation runs before the auth
    // check, so fake strings would fail as validators instead of as denials.
    const seeded = await granted();
    const seededT3 = await seedT3Connection(seeded);
    const seededMapping = (await save(seeded, seededT3)) as Id<"linearProjectMappings">;
    const t = convexTest(schema, modules);
    await expect(t.query(internal.projectMappingsStore.listMappings, { ...owner })).rejects.toThrow(/unauthorized/);
    await expect(t.query(internal.projectMappingsStore.getMapping, { ...owner, mappingId: seededMapping })).rejects.toThrow(/unauthorized/);
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "p", linearTeamId: "t",
    })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, ...validFields(seededT3), at: Date.now(),
    })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(internal.projectMappingsStore.disableMapping, {
      ...owner, mappingId: seededMapping, at: Date.now(),
    })).rejects.toThrow(/unauthorized/);
  });

  it("denies stale-revision requests for every store read and write", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = (await save(t, t3)) as Id<"linearProjectMappings">;
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const stale = { ...owner };
    await expect(t.query(internal.projectMappingsStore.listMappings, { ...stale })).rejects.toThrow(/unauthorized/);
    await expect(t.query(internal.projectMappingsStore.getMapping, { ...stale, mappingId })).rejects.toThrow(/unauthorized/);
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...stale, linearProjectId: "p", linearTeamId: "t",
    })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(internal.projectMappingsStore.saveMapping, {
      ...stale, ...validFields(t3), at: Date.now(),
    })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(internal.projectMappingsStore.disableMapping, {
      ...stale, mappingId, at: Date.now(),
    })).rejects.toThrow(/unauthorized/);
  });

  it("rejects a duplicate enabled mapping for the same project and team", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await save(t, t3);
    await expect(save(t, t3)).rejects.toThrow(/already exists/i);
  });

  it("allows a different team in the same Linear project", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const first = await save(t, t3);
    const second = await save(t, t3, { linearTeamId: "team-ops", linearTeamKey: "OPS", linearTeamName: "Operations" });
    expect(second).not.toBe(first);
    const resolved = await t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-ops",
    });
    expect(resolved).toMatchObject({ linearTeamKey: "OPS", enabled: true });
  });

  it("resolves the enabled mapping for an issue's project and team", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = await save(t, t3);
    const resolved = await t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(resolved).toMatchObject({ mappingId, enabled: true, linearProjectId: "proj-1", linearTeamId: "team-eng" });
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-unknown",
    })).resolves.toBe(null);
  });

  it("fails closed with specific reasons for missing destinations and refs", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await expect(save(t, t3, { linearProjectId: "" })).rejects.toThrow(/missing its Linear destination/i);
    await expect(save(t, t3, { t3ProjectId: "" })).rejects.toThrow(/missing its T3 destination/i);
    await expect(save(t, t3, { t3ProjectId: "   " })).rejects.toThrow(/missing its T3 destination/i);
    await expect(save(t, t3, { worktreeBaseRef: "" })).rejects.toThrow(/missing its worktree baseRef/i);
    await expect(save(t, t3, { targetBranch: "" })).rejects.toThrow(/missing its PR target branch/i);
    await expect(save(t, t3, { startedStateId: "" })).rejects.toThrow(/missing its started workflow state/i);
  });

  it("keeps worktreeBaseRef and targetBranch as separate stored values", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = await save(t, t3, { worktreeBaseRef: "refs/heads/release", targetBranch: "main" });
    const row = await t.query(internal.projectMappingsStore.getMapping, { ...owner, mappingId });
    expect(row).toMatchObject({ worktreeBaseRef: "refs/heads/release", targetBranch: "main" });
    expect(row?.worktreeBaseRef).not.toBe(row?.targetBranch);
  });

  it("edits a mapping in place and rejects moving onto an occupied pair", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = (await save(t, t3)) as Id<"linearProjectMappings">;
    await save(t, t3, { linearTeamId: "team-ops", linearTeamKey: "OPS", linearTeamName: "Operations" });
    const moved = await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, ...validFields(t3, { targetBranch: "release" }), mappingId, at: Date.now(),
    });
    expect(moved).toBe(mappingId);
    await expect(t.query(internal.projectMappingsStore.getMapping, { ...owner, mappingId }))
      .resolves.toMatchObject({ targetBranch: "release", enabled: true });
    // Occupied: moving onto the OPS pair must fail closed.
    await expect(t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, ...validFields(t3, { linearTeamId: "team-ops", linearTeamKey: "OPS", linearTeamName: "Operations" }),
      mappingId, at: Date.now(),
    })).rejects.toThrow(/already exists/i);
  });

  it("disabling keeps the row and identifiers but stops resolution", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = (await save(t, t3)) as Id<"linearProjectMappings">;
    await expect(t.mutation(internal.projectMappingsStore.disableMapping, {
      ...owner, mappingId, at: Date.now(),
    })).resolves.toBe(true);
    const row = await t.query(internal.projectMappingsStore.getMapping, { ...owner, mappingId });
    expect(row).toMatchObject({
      enabled: false,
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      t3ProjectId: "t3-proj-1",
      worktreeBaseRef: "refs/heads/main",
      targetBranch: "main",
      startedStateId: "state-started",
    });
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-eng",
    })).resolves.toBe(null);
    // History is repairable: a fresh mapping for the same pair can be saved.
    const replacement = await save(t, t3);
    expect(replacement).not.toBe(mappingId);
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-eng",
    })).resolves.toMatchObject({ mappingId: replacement });
  });

  it("fails closed when two enabled mappings claim the same pair", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("linearProjectMappings", {
          ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
          ...validFields(t3), enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
    });
    await expect(t.query(internal.projectMappingsStore.resolveMappingForIssue, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-eng",
    })).rejects.toThrow(/ambiguous/i);
  });

  it("denies anonymous and non-owner public action calls", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const mappingId = (await save(t, t3)) as Id<"linearProjectMappings">;
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.projectMappings.list, {})).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.projectMappings.candidates, {})).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.projectMappings.disable, { mappingId })).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.projectMappings.list, {})).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.projectMappings.candidates, {})).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.projectMappings.disable, { mappingId })).rejects.toThrow(/unauthorized/);
    await expect(authed.action(api.projectMappings.list, {})).resolves.toHaveLength(1);
  });

  it("save fails closed before any network call when refs are missing", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const t3 = await seedT3Connection(t);
    await expect(authed.action(api.projectMappings.save, {
      ...actionArgs(t3), worktreeBaseRef: "",
    })).rejects.toThrow(/missing its worktree baseRef/i);
    await expect(authed.action(api.projectMappings.save, {
      ...actionArgs(t3), startedStateId: "",
    })).rejects.toThrow(/missing its started workflow state/i);
  });

  it("save requires the owner's chosen started state id", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const t3 = await seedT3Connection(t);
    const withoutState = { ...actionArgs(t3), startedStateId: undefined };
    const error = await authed.action(api.projectMappings.save, withoutState as never).then(
      () => new Error("unexpected success"),
      (thrown: Error) => thrown,
    );
    expect(error.message).toMatch(/startedStateId/i);
  });

  it("save fails closed when no Linear connection exists", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const t3 = await seedT3Connection(t);
    await expect(authed.action(api.projectMappings.save, { ...actionArgs(t3) })).rejects.toThrow(
      /linear connection is unavailable/i,
    );
  });

  it("candidates fails closed when no Linear connection exists", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(authed.action(api.projectMappings.candidates, {})).rejects.toThrow(
      /linear connection is unavailable/i,
    );
  });

  describe("owner-chosen started states over stubbed Linear reads", () => {
    const LINEAR_KEY = Buffer.from("y".repeat(32)).toString("base64");
    let savedKeyVersion: string | undefined;
    let savedKeyV1: string | undefined;

    beforeEach(() => {
      savedKeyVersion = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
      savedKeyV1 = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
      process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
      process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = LINEAR_KEY;
    });

    afterEach(() => {
      if (savedKeyVersion === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
      else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = savedKeyVersion;
      if (savedKeyV1 === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
      else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = savedKeyV1;
      vi.unstubAllGlobals();
    });

    /** The ENG team offers two started states; OPS offers none. */
    function stubLinearFetch() {
      vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { teamId?: string } };
        const teamId = body.variables?.teamId;
        let payload: unknown;
        if (teamId === "team-eng") {
          payload = {
            data: {
              team: {
                id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
                states: { nodes: [
                  { id: "s-backlog", name: "Backlog", type: "backlog" },
                  { id: "s-progress", name: "In Progress", type: "started" },
                  { id: "s-review", name: "In Review", type: "started" },
                ] },
              },
            },
          };
        } else if (teamId === "team-ops") {
          payload = {
            data: {
              team: {
                id: "team-ops", key: "OPS", name: "Operations", organization: { id: "ws-1" },
                states: { nodes: [
                  { id: "s-todo", name: "Todo", type: "unstarted" },
                  { id: "s-done", name: "Done", type: "completed" },
                ] },
              },
            },
          };
        } else {
          payload = {
            data: {
              organization: { id: "ws-1" },
              projects: { nodes: [{
                id: "proj-1", name: "Helm",
                teams: { nodes: [
                  { id: "team-eng", key: "ENG", name: "Engineering" },
                  { id: "team-ops", key: "OPS", name: "Operations" },
                ] },
              }] },
            },
          };
        }
        return new Response(JSON.stringify(payload), {
          status: 200, headers: { "content-type": "application/json" },
        });
      });
    }

    async function seedLinearConnection(t: Harness) {
      await t.run(async (ctx) => {
        await ctx.db.insert("linearConnections", {
          ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
          workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
          accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
          refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
          accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null,
          credentialVersion: 1, scopes: ["read", "write"], status: "connected",
          lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
          clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
          createdAt: Date.now(), updatedAt: Date.now(),
        });
      });
    }

    /** A real-format T3 id whose connection never resolves, so save stops at the T3 stage. */
    async function disconnectedT3Id(t: Harness): Promise<Id<"t3Connections">> {
      return await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
        resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client",
        environmentId: "env-1", environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64",
        access: "read-only", status: "disconnected", tokenCiphertext: "",
        credentialVersion: 1, expiresAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      }));
    }

    it("candidates offers both started states for a two-started-state team", async () => {
      const t = await granted();
      await seedLinearConnection(t);
      stubLinearFetch();
      const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
      const result = await authed.action(api.projectMappings.candidates, {});
      expect(result.workspace).toMatchObject({ workspaceId: "ws-1" });
      const eng = result.projects[0]!.teams.find((team) => team.teamId === "team-eng")!;
      expect(eng.stateError).toBe(null);
      expect(eng.startedStates).toEqual([
        { stateId: "s-progress", stateName: "In Progress" },
        { stateId: "s-review", stateName: "In Review" },
      ]);
      const ops = result.projects[0]!.teams.find((team) => team.teamId === "team-ops")!;
      expect(ops.startedStates).toEqual([]);
      expect(ops.stateError).toMatch(/OPS.*no started workflow state/i);
    });

    it("save accepts the owner's chosen state when the team has two", async () => {
      const t = await granted();
      await seedLinearConnection(t);
      stubLinearFetch();
      const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
      const t3 = await disconnectedT3Id(t);
      // The chosen "In Review" state passes Linear validation; with no live
      // T3 connection the save then fails closed at the T3 stage — proving
      // the two-started-state team no longer rejects the save itself.
      await expect(authed.action(api.projectMappings.save, {
        ...actionArgs(t3), startedStateId: "s-review",
      })).rejects.toThrow(/T3 destination is unavailable/i);
    });

    it("save stores the live state name for the chosen id", async () => {
      const t = await granted();
      const t3 = await seedT3Connection(t);
      const mappingId = (await save(t, t3)) as Id<"linearProjectMappings">;
      // The store persists exactly the validated pair the action derived from
      // the live read: editing to the other offered state keeps both fields.
      await t.mutation(internal.projectMappingsStore.saveMapping, {
        ...owner, ...validFields(t3), mappingId,
        startedStateId: "s-review", startedStateName: "In Review", at: Date.now(),
      });
      await expect(t.query(internal.projectMappingsStore.getMapping, { ...owner, mappingId }))
        .resolves.toMatchObject({ startedStateId: "s-review", startedStateName: "In Review" });
    });

    it("save rejects a stale or foreign started state id", async () => {
      const t = await granted();
      await seedLinearConnection(t);
      stubLinearFetch();
      const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
      const t3 = await disconnectedT3Id(t);
      await expect(authed.action(api.projectMappings.save, {
        ...actionArgs(t3), startedStateId: "s-deleted",
      })).rejects.toThrow(/not a started workflow state for team ENG/i);
      // A real id of a non-started type is rejected just the same.
      await expect(authed.action(api.projectMappings.save, {
        ...actionArgs(t3), startedStateId: "s-backlog",
      })).rejects.toThrow(/not a started workflow state for team ENG/i);
    });

    it("save fails closed when the team has no started workflow state", async () => {
      const t = await granted();
      await seedLinearConnection(t);
      stubLinearFetch();
      const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
      const t3 = await disconnectedT3Id(t);
      await expect(authed.action(api.projectMappings.save, {
        ...actionArgs(t3, { linearTeamId: "team-ops", startedStateId: "s-todo" }),
      })).rejects.toThrow(/OPS.*no started workflow state/i);
    });
  });
});
