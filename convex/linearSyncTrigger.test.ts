/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };
const modules = import.meta.glob("./**/*.ts");
const ISSUE_ID = "issue-uuid-1";
const LINEAR_GRAPHQL_HOST = "https://api.linear.app/graphql";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function issuePayload(stateId = "s-backlog"): unknown {
  return {
    data: {
      organization: { id: "ws-1" },
      issue: {
        id: ISSUE_ID, identifier: "EGA-762", title: "Linear sync", url: "u", priority: 2, priorityLabel: "High",
        description: null, state: { id: stateId, name: "Backlog", type: "unstarted" },
        team: { id: "team-eng", key: "ENG", name: "Engineering" }, project: { id: "proj-1" }, assignee: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

const TEAM_STATES_ENG = {
  data: { team: { id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
    states: { nodes: [
      { id: "s-backlog", name: "Backlog", type: "unstarted" },
      { id: "s-progress", name: "In Progress", type: "started" },
    ] } } },
};

describe("linear sync trigger (B3)", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;
  let savedKeyVersion: string | undefined;
  let savedKeyV1: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    savedKeyVersion = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
    savedKeyV1 = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("y".repeat(32)).toString("base64");
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT; else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL; else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
    if (savedKeyVersion === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION; else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = savedKeyVersion;
    if (savedKeyV1 === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1; else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = savedKeyV1;
    vi.unstubAllGlobals();
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedAll(t: ReturnType<typeof convexTest>) {
    const t3ConnectionId = await t.run(async (ctx) => ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client", environmentId: "env-1",
      environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64", access: "operate",
      status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder", credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000, createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main", startedStateId: "s-progress",
      startedStateName: "In Progress", at: Date.now(),
    });
    await t.run(async (ctx) => ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null, credentialVersion: 1, scopes: ["read", "write"],
      status: "connected", lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-762", t3ConnectionId, t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(1), attemptId: "attempt-1",
      correlationKey: `[helm:${ISSUE_ID}:testcorr]`, at: Date.now(),
    });
    return t3ConnectionId;
  }

  function installLinearStub(details: unknown[]) {
    let detailIndex = 0;
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected network target: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (body.query.startsWith("mutation")) {
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query === "query LinearIssueDetail" || body.query.includes("issue(id:")) {
        // fallback: match by containing issue
      }
      // detect detail query by checking a known field
      const frame = details[Math.min(detailIndex, details.length - 1)];
      detailIndex += 1;
      if (body.query === (await import("./lib/linearIssues")).LINEAR_ISSUE_DETAIL_QUERY) {
        return new Response(JSON.stringify(frame), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query === (await import("./lib/linearGraphql")).LINEAR_TEAM_STATES_QUERY) {
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Generic: if query contains "issue(", treat as detail
      if (body.query.includes("issue(id:")) {
        return new Response(JSON.stringify(frame), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("states")) {
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);
  }

  // Import query constants lazily to avoid top-level await issues
  // (handled inside stub by dynamic import)

  it("scheduled sync performs exactly one Linear state write", async () => {
    const t = await granted();
    await seedAll(t);
    // Linear stub: first detail Backlog, team states ENG
    let detailCalls = 0;
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (body.query.startsWith("mutation")) {
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("issue(id:")) {
        detailCalls += 1;
        return new Response(JSON.stringify(issuePayload("s-backlog")), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("states")) {
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);

    // count mutations via fetch stub
    let mutationCount = 0;
    const countingFetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (body.query.startsWith("mutation")) {
        mutationCount += 1;
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("issue(id:")) {
        return new Response(JSON.stringify(issuePayload("s-backlog")), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("states")) {
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", countingFetch);

    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await t.action(internal.linearSync.runScheduledSync, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
    });
    expect(result).not.toBeNull();
    // two reads (first + pre-mutation) + post-read = at least one mutation
    expect(mutationCount).toBe(1);
  });

  it("running the trigger twice performs no second Linear write", async () => {
    const t = await granted();
    await seedAll(t);
    let mutationCount = 0;
    let synced = false;
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (body.query.startsWith("mutation")) {
        mutationCount += 1;
        synced = true;
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("issue(id:")) {
        return new Response(JSON.stringify(issuePayload(synced ? "s-progress" : "s-backlog")), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("states")) {
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);

    await t.action(internal.linearSync.runScheduledSync, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
    });
    const first = mutationCount;
    await t.action(internal.linearSync.runScheduledSync, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
    });
    expect(mutationCount).toBe(first);
  });

  it("cron selects only retryable rows and skips manual associations", async () => {
    const t = await granted();
    // create a retryable ledger row + a manual (attemptId empty) row
    const t3ConnectionId = await t.run(async (ctx) => ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client", environmentId: "env-1",
      environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64", access: "operate",
      status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder", credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000, createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
    // launch-derived association
    const assoc = await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-762", t3ConnectionId, t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(1), attemptId: "attempt-1",
      correlationKey: `[helm:${ISSUE_ID}:testcorr]`, at: Date.now(),
    });
    // manual association (attemptId empty) by direct insert
    const manualAssocId = await t.run(async (ctx) => ctx.db.insert("linearIssueThreads", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: "issue-manual", linearIssueIdentifier: "EGA-MAN", t3ConnectionId,
      t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(2),
      attemptId: "", correlationKey: "", createdAt: Date.now(),
    }));
    // ledger row retryable for launch-derived
    await t.run(async (ctx) => ctx.db.patch(
      (await ctx.db.query("linearSyncLedger").withIndex("by_association", q => q.eq("associationId", assoc.associationId)).first())!._id,
      { state: "retryable", updatedAt: Date.now() - 300_000, attemptCount: 1, lastErrorCode: "timed_out" },
    ));
    // manual ledger row linked
    await t.run(async (ctx) => ctx.db.insert("linearSyncLedger", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      associationId: manualAssocId, linearWorkspaceId: "ws-1", linearIssueId: "issue-manual",
      linearIssueIdentifier: "EGA-MAN", linearTeamId: "team-eng", targetStateId: null, targetStateName: null,
      state: "retryable", attemptCount: 0, lastErrorCode: null, observedStateId: null, observedStateName: null,
      observedStateType: null, createdAt: Date.now(), updatedAt: Date.now() - 100000,
    }));

    // mapping + linear connection for sync to run
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main", startedStateId: "s-progress",
      startedStateName: "In Progress", at: Date.now(),
    });
    await t.run(async (ctx) => ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null, credentialVersion: 1, scopes: ["read", "write"],
      status: "connected", lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));

    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (body.query.startsWith("mutation")) {
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("issue(id:")) {
        return new Response(JSON.stringify(issuePayload("s-backlog")), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.query.includes("states")) {
        return new Response(JSON.stringify({ data: { team: { id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" }, states: { nodes: [{ id: "s-backlog", name: "Backlog", type: "unstarted" }, { id: "s-progress", name: "In Progress", type: "started" }] } } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);

    const manualBefore = await t.run(async (ctx) => ctx.db.get(manualAssocId));
    const manualLedgerBefore = await t.run(async (ctx) => ctx.db
      .query("linearSyncLedger").withIndex("by_association", q => q.eq("associationId", manualAssocId)).first());
    const now = Date.now();
    const result = await t.action(internal.linearSync.driveRetryable, { now });
    expect(result.processed).toBeGreaterThanOrEqual(1);
    // manual row (attemptId === "") is never touched by the driver
    const manualLedgerAfter = await t.run(async (ctx) => ctx.db
      .query("linearSyncLedger").withIndex("by_association", q => q.eq("associationId", manualAssocId)).first());
    expect(manualLedgerAfter!.attemptCount).toBe(manualLedgerBefore!.attemptCount);
    expect(manualLedgerAfter!.updatedAt).toBe(manualLedgerBefore!.updatedAt);
  });

  it("a persistently failing row stops being retried at the bound", async () => {
    const t = await granted();
    const t3ConnectionId = await t.run(async (ctx) => ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client", environmentId: "env-1",
      environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64", access: "operate",
      status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder", credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000, createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
    const assoc = await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-762", t3ConnectionId, t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(1), attemptId: "attempt-1",
      correlationKey: `[helm:${ISSUE_ID}:testcorr]`, at: Date.now(),
    });
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main", startedStateId: "s-progress",
      startedStateName: "In Progress", at: Date.now(),
    });
    await t.run(async (ctx) => ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null, credentialVersion: 1, scopes: ["read", "write"],
      status: "connected", lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await t.run(async (ctx) => ctx.db.patch(
      (await ctx.db.query("linearSyncLedger").withIndex("by_association", q => q.eq("associationId", assoc.associationId)).first())!._id,
      { state: "retryable", updatedAt: 0, attemptCount: 100, lastErrorCode: "timed_out" },
    ));
    const result = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    expect(result.processed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.reasons.bound).toBeGreaterThanOrEqual(1);
  });
});
