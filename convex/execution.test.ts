/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";

/**
 * Execution preflight contract (EGA-761).
 *
 * Owner-gated, read-only: resolves the enabled mapping, re-checks the Linear
 * grant and the T3 connection, then reads the T3 catalog live through
 * `api.t3OAuth.read`. Every must-disable condition surfaces as a non-empty
 * actionable `blockers` list. Launches nothing: no T3 thread, no worktree, no
 * Linear write.
 *
 * No live Linear or T3 connection exists in this environment, so the live
 * catalog success path is NOT proven here: with a connected T3 destination
 * the preflight attempts the live read and reports its failure as a blocker.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

const LINEAR_KEY = Buffer.from("z".repeat(32)).toString("base64");

describe("execution preflight", () => {
  let savedKeys: Record<string, string | undefined>;
  let savedOwner: Record<string, string | undefined>;

  beforeEach(() => {
    savedKeys = {
      LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION,
      LINEAR_OAUTH_ENCRYPTION_KEY_V1: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1,
      LINEAR_OAUTH_ENCRYPTION_KEY: process.env.LINEAR_OAUTH_ENCRYPTION_KEY,
    };
    savedOwner = {
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
    };
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = LINEAR_KEY;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries({ ...savedKeys, ...savedOwner })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedT3(t: Harness, status: "connected" | "reauthorizationRequired" | "expired" = "connected") {
    return await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client",
      environmentId: "env-1", environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64",
      access: "read-only", status, tokenCiphertext: "v1.token.placeholder.placeholder",
      credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
  }

  async function seedLinear(t: Harness, overrides: Record<string, unknown> = {}) {
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
        ...overrides,
      });
    });
  }

  async function seedMapping(t: Harness, t3ConnectionId: Id<"t3Connections">) {
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner,
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main",
      startedStateId: "state-started", startedStateName: "In Progress",
      at: Date.now(),
    });
  }

  it("denies anonymous and non-owner callers", async () => {
    const t = await granted();
    const t3 = await seedT3(t);
    await seedLinear(t);
    await seedMapping(t, t3);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.execution.preflight, { linearProjectId: "proj-1", linearTeamId: "team-eng" }))
      .rejects.toThrow(/unauthorized/);
    await expect(other.action(api.execution.preflight, { linearProjectId: "proj-1", linearTeamId: "team-eng" }))
      .rejects.toThrow(/unauthorized/);
  });

  it("reports a missing mapping as a non-empty actionable blocker", async () => {
    const t = await granted();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-unknown", linearTeamId: "team-eng",
    });
    expect(verdict.t3ConnectionId).toBe(null);
    expect(verdict.catalog).toBe(null);
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/map/i);
  });

  it("reports a disabled mapping as a blocker", async () => {
    const t = await granted();
    const t3 = await seedT3(t);
    await seedLinear(t);
    await seedMapping(t, t3);
    const rows = await t.run(async (ctx) => await ctx.db.query("linearProjectMappings").take(5));
    await t.mutation(internal.projectMappingsStore.disableMapping, {
      ...owner, mappingId: rows[0]!._id, at: Date.now(),
    });
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/map/i);
  });

  it("reports a revoked Linear grant as a blocker", async () => {
    const t = await granted();
    const t3 = await seedT3(t);
    await seedLinear(t, { status: "reauthorizationRequired" });
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/revoked/i);
  });

  it("reports an expired Linear grant as a blocker", async () => {
    const t = await granted();
    const t3 = await seedT3(t);
    await seedLinear(t, { status: "expired", accessExpiresAt: Date.now() - 1_000 });
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/expired/i);
  });

  it("reports a revoked T3 connection as a blocker", async () => {
    const t = await granted();
    const t3 = await seedT3(t, "reauthorizationRequired");
    await seedLinear(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.catalog).toBe(null);
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/revoked/i);
  });

  it("reports an expired T3 connection as a blocker", async () => {
    const t = await granted();
    const t3 = await seedT3(t, "expired");
    await seedLinear(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers.join(" ")).toMatch(/expired/i);
  });

  it("attempts the live catalog read and surfaces its failure as a blocker without throwing", async () => {
    const t = await granted();
    const t3 = await seedT3(t, "connected");
    await seedLinear(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    // No live T3 here: the read fails and the verdict carries the failure as
    // a blocker (catalog null) rather than throwing.
    const verdict = await authed.action(api.execution.preflight, {
      linearProjectId: "proj-1", linearTeamId: "team-eng",
    });
    expect(verdict.t3ConnectionId).not.toBe(null);
    expect(verdict.worktreeBaseRef).toBe("refs/heads/main");
    expect(verdict.targetBranch).toBe("main");
    expect(verdict.startedStateId).toBe("state-started");
    expect(verdict.catalog).toBe(null);
    expect(verdict.blockers.length).toBeGreaterThan(0);
  });

  it("performs no writes", async () => {
    const t = await granted();
    const t3 = await seedT3(t, "reauthorizationRequired");
    await seedLinear(t);
    await seedMapping(t, t3);
    const before = await t.run(async (ctx) => ({
      mappings: (await ctx.db.query("linearProjectMappings").take(10)).length,
      linear: (await ctx.db.query("linearConnections").take(10)).length,
      t3: (await ctx.db.query("t3Connections").take(10)).length,
    }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.execution.preflight, { linearProjectId: "proj-1", linearTeamId: "team-eng" });
    const after = await t.run(async (ctx) => ({
      mappings: (await ctx.db.query("linearProjectMappings").take(10)).length,
      linear: (await ctx.db.query("linearConnections").take(10)).length,
      t3: (await ctx.db.query("t3Connections").take(10)).length,
    }));
    expect(after).toEqual(before);
  });
});
