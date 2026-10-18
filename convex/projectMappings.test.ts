/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Project mapping store and action contract (EGA-760).
 *
 * Exercised through the internal store (no network, no live Linear or T3)
 * plus the public owner-gated actions for authorization shape. Under test:
 * owner+revision gating on every read and write, the (owner, project, team)
 * uniqueness rule, explicit fail-closed reasons for missing destinations and
 * refs, disable-keeps-history semantics, and baseRef/targetBranch separation.
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
    const seededMapping = (await save(seeded, seededT3)) as Id<"projectMappings">;
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
    const mappingId = (await save(t, t3)) as Id<"projectMappings">;
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
    const mappingId = (await save(t, t3)) as Id<"projectMappings">;
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
    const mappingId = (await save(t, t3)) as Id<"projectMappings">;
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
        await ctx.db.insert("projectMappings", {
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
    const mappingId = (await save(t, t3)) as Id<"projectMappings">;
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
    const base = { ...validFields(t3), worktreeBaseRef: "" };
    await expect(authed.action(api.projectMappings.save, base)).rejects.toThrow(/missing its worktree baseRef/i);
  });

  it("save fails closed when no Linear connection exists", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const t3 = await seedT3Connection(t);
    await expect(authed.action(api.projectMappings.save, { ...validFields(t3) })).rejects.toThrow(
      /linear connection is unavailable/i,
    );
  });
});
