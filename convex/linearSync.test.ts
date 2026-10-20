/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { LINEAR_ISSUE_DETAIL_QUERY } from "./lib/linearIssues";
import { LINEAR_TEAM_STATES_QUERY } from "./lib/linearGraphql";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";

/**
 * EGA-762: the Linear In Progress synchronization ledger, driven end to end
 * over a STUBBED fetch (no real Linear network). Under test:
 *
 *  - one accepted association = one linearSyncLedger row; target state comes
 *    from the issue's OWN team (never a global default);
 *  - 429 -> retryable with no state change and no relaunch race;
 *  - timeouts -> re-read, then retryable or synced from observed truth;
 *  - HTTP 200 with a GraphQL `errors` array is failure, never success;
 *  - Done / Canceled / moved / externally-changed issues are recorded
 *    `conflicted` and never overwritten;
 *  - missing / expired / revoked Linear authorization ->
 *    `authorization_required` without crashing;
 *  - sync retries never launch a T3 thread (the launch tables stay empty).
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");

const ISSUE_ID = "issue-uuid-1";
const LINEAR_GRAPHQL_HOST = "https://api.linear.app/graphql";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

interface IssueMarker {
  state?: { id: string; name: string; type: string };
  teamId?: string;
  teamKey?: string;
  updatedAt?: string;
}
function issuePayload(marker: IssueMarker = {}): unknown {
  return {
    data: {
      organization: { id: "ws-1" },
      issue: {
        id: ISSUE_ID,
        identifier: "EGA-762",
        title: "Linear sync",
        url: "https://linear.app/helm/issue/EGA-762",
        priority: 2,
        priorityLabel: "High",
        description: null,
        state: marker.state ?? { id: "s-backlog", name: "Backlog", type: "unstarted" },
        team: { id: marker.teamId ?? "team-eng", key: marker.teamKey ?? "ENG", name: "Engineering" },
        project: { id: "proj-1" },
        assignee: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: marker.updatedAt ?? "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

const TEAM_STATES_ENG = {
  data: {
    team: {
      id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
      states: { nodes: [
        { id: "s-backlog", name: "Backlog", type: "unstarted" },
        { id: "s-progress", name: "In Progress", type: "started" },
        { id: "s-review", name: "In Review", type: "started" },
      ] },
    },
  },
};

const TEAM_STATES_OPS = {
  data: {
    team: {
      id: "team-ops", key: "OPS", name: "Operations", organization: { id: "ws-1" },
      states: { nodes: [
        { id: "s-ops-todo", name: "Ops Todo", type: "unstarted" },
        { id: "s-ops-start", name: "Ops Flow", type: "started" },
      ] },
    },
  },
};

const TEAM_STATES_INVALID = {
  data: {
    team: {
      id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
      states: { nodes: [
        { id: "s-backlog", name: "Backlog", type: "unstarted" },
        { id: "s-done", name: "Done", type: "completed" },
      ] },
    },
  },
};

function mutationErrorPayload(): unknown {
  return { errors: [{ message: "GraphQL reported a partial failure" }] };
}

describe("linear sync", () => {
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
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
    if (savedKeyVersion === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
    else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = savedKeyVersion;
    if (savedKeyV1 === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
    else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = savedKeyV1;
    vi.unstubAllGlobals();
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedT3Connection(t: ReturnType<typeof convexTest>): Promise<Id<"t3Connections">> {
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
      access: "operate",
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

  async function seedMapping(
    t: ReturnType<typeof convexTest>,
    t3ConnectionId: Id<"t3Connections">,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner,
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
      startedStateId: "s-progress",
      startedStateName: "In Progress",
      at: Date.now(),
      ...overrides,
    });
  }

  async function seedLinearConnection(
    t: ReturnType<typeof convexTest>,
    overrides: { accessExpiresAt?: number; status?: string } = {},
  ): Promise<void> {
    await t.run(async (ctx) => await ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: overrides.accessExpiresAt ?? Date.now() + 3_600_000,
      refreshExpiresAt: null,
      credentialVersion: 1, scopes: ["read", "write"], status: (overrides.status ?? "connected") as "connected",
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
  }

  async function seedAssociation(
    t: ReturnType<typeof convexTest>,
    t3ConnectionId: Id<"t3Connections">,
    overrides: Record<string, string> = {},
  ) {
    return await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner,
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-762",
      t3ConnectionId,
      t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1",
      t3ThreadId: testThreadId(1),
      attemptId: "attempt-1",
      correlationKey: `[helm:${ISSUE_ID}:testcorr]`,
      at: Date.now(),
      ...overrides,
    });
  }

  function sync(t: ReturnType<typeof convexTest>, overrides: Record<string, string> = {}) {
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return authed.action(api.linearSync.syncIssue, {
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      ...overrides,
    });
  }

  async function ledgerOf(t: ReturnType<typeof convexTest>, associationId: string) {
    return await t.query(internal.linearAssociationStore.ledgerForAssociation, {
      ...owner, associationId,
    });
  }

  /** Ordered detail-frame stub; the LAST frame repeats for extra reads. */
  function installLinearStub(config: {
    details: unknown[];
    mutationResponse?: unknown | Error;
    teamStates?: unknown;
  }) {
    const calls = { detail: 0, states: 0, mutation: 0 };
    const mutationArgs: (Record<string, string> | null)[] = [];
    let detailIndex = 0;
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) {
        // The sync path may only ever speak to the Linear GraphQL endpoint.
        throw new Error(`unexpected network target during sync: ${url}`);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, string> };
      if (body.query.startsWith("mutation")) {
        calls.mutation += 1;
        mutationArgs.push(body.variables ?? null);
        if (config.mutationResponse instanceof Error) throw config.mutationResponse;
        if (config.mutationResponse !== undefined) {
          return new Response(JSON.stringify(config.mutationResponse), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_ISSUE_DETAIL_QUERY) {
        calls.detail += 1;
        const frame = config.details[Math.min(detailIndex, config.details.length - 1)];
        if (frame === undefined) throw new Error("stub is out of detail frames");
        detailIndex += 1;
        if (frame instanceof Error) throw frame;
        return new Response(JSON.stringify(frame), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_TEAM_STATES_QUERY) {
        calls.states += 1;
        const payload = config.teamStates ?? TEAM_STATES_ENG;
        if (payload instanceof Error) throw payload;
        return new Response(JSON.stringify(payload), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected Linear GraphQL query in stub: ${body.query.slice(0, 60)}`);
    };
    vi.stubGlobal("fetch", fetchStub);
    return { calls, mutationArgs };
  }

  it("syncs a never-started issue into its team's In Progress state and records synced from the re-read", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const startedAgain = issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "2026-01-01T01:00:00.000Z" });
    const stub = installLinearStub({
      details: [issuePayload(), issuePayload(), startedAgain],
      teamStates: TEAM_STATES_ENG,
    });

    const result = await sync(t);
    expect(result).toMatchObject({
      outcome: "synced",
      associations: 1,
      targetStateId: "s-progress",
      targetStateName: "In Progress",
      observedStateId: "s-progress",
      attemptCount: 1,
    });
    expect(stub.calls.mutation).toBe(1);
    expect(stub.calls.detail).toBe(3);
    expect(stub.calls.states).toBe(1);
    expect(stub.mutationArgs[0]).toEqual({ issueId: ISSUE_ID, stateId: "s-progress" });

    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger).toMatchObject({
      state: "synced",
      attemptCount: 1,
      lastErrorCode: null,
      targetStateId: "s-progress",
      targetStateName: "In Progress",
      observedStateId: "s-progress",
      observedStateType: "started",
    });
    expect(ledger?.note).toContain("re-read");
  });

  it("a Linear 429 is retryable, changes nothing on Linear, retries only the ledger, and never relaunches", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    // The stub counts every call, then replaces fetch with a raw-429 handler
    // for the state-write so `linearJson` surfaces `Linear request failed (429)`.
    const stub = installLinearStub({ details: [issuePayload(), issuePayload()], teamStates: TEAM_STATES_ENG });
    vi.unstubAllGlobals();
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, string> };
      if (String(input) !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected target: ${String(input)}`);
      if (body.query.startsWith("mutation")) {
        stub.calls.mutation += 1; stub.mutationArgs.push(body.variables ?? null);
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_ISSUE_DETAIL_QUERY) {
        stub.calls.detail += 1;
        return new Response(JSON.stringify(issuePayload()), { status: 200, headers: { "content-type": "application/json" } });
      }
      stub.calls.states += 1;
      return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);
    const first = await sync(t);
    expect(first).toMatchObject({ outcome: "retryable", attemptCount: 1 });
    const ledger1 = await ledgerOf(t, association.associationId);
    expect(ledger1).toMatchObject({ state: "retryable", lastErrorCode: "rate_limited", attemptCount: 1 });

    // The 429 path must never relaunch anything: no attempt rows, no extra T3
    // connections, and the Linear tables still hold exactly one association.
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => await ctx.db.query("t3Connections").collect())).toHaveLength(1);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(1);

    // A deliberate retry (same owner-gated call) attempts again and stays
    // retryable — the retry loop lives entirely in the ledger.
    const second = await sync(t);
    expect(second).toMatchObject({ outcome: "retryable", attemptCount: 2 });
    expect(await ledgerOf(t, association.associationId)).toMatchObject({ state: "retryable", attemptCount: 2 });
    expect(stub.calls.mutation).toBe(2);
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
  });

  it("HTTP 200 with a GraphQL errors array is failure, not success, even when the re-read shows the target", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        // The post-write re-read would show the target state; the partial
        // GraphQL error response still must NOT conclude synced.
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
      mutationResponse: mutationErrorPayload(),
    });

    const result = await sync(t);
    expect(result.outcome).toBe("retryable");
    expect(result.observedStateId).toBe("s-progress");
    expect(stub.calls.mutation).toBe(1);
    expect(stub.calls.detail).toBe(3);
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger).toMatchObject({
      state: "retryable",
      lastErrorCode: "graph_ql_errors",
      targetStateId: "s-progress",
      observedStateId: "s-progress",
    });
    expect(ledger?.state).not.toBe("synced");
  });

  it("a timed-out write is re-read: synced when the re-read observes the target state", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
      mutationResponse: new Error("Linear request timed out"),
    });

    const result = await sync(t);
    expect(result).toMatchObject({ outcome: "synced", attemptCount: 1, observedStateId: "s-progress" });
    expect(stub.calls.mutation).toBe(1);
    expect(stub.calls.detail).toBe(3); // the uncertain write was re-read
    expect(await ledgerOf(t, association.associationId)).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it("a timed-out write is re-read: retryable when the re-read shows no change; never crash-converted to success", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    installLinearStub({
      details: [issuePayload(), issuePayload(), issuePayload()],
      teamStates: TEAM_STATES_ENG,
      mutationResponse: new Error("Linear request timed out"),
    });

    const result = await sync(t);
    expect(result.outcome).toBe("retryable");
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger).toMatchObject({ state: "retryable", lastErrorCode: "timed_out", observedStateId: "s-backlog" });
  });

  it("a timed-out write whose post-write re-read also fails stays explicitly NOT synced", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        new Error("Linear request timed out"),
      ],
      teamStates: TEAM_STATES_ENG,
      mutationResponse: new Error("Linear request timed out"),
    });

    const result = await sync(t);
    expect(result.outcome).toBe("retryable");
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger).toMatchObject({ state: "retryable", lastErrorCode: "timed_out" });
    expect(ledger?.observedStateId).toBe(null);
    expect(ledger?.note).toContain("nothing was concluded");
  });

  it("an issue already in the target state records synced without any write", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" } })],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("synced");
    expect(stub.calls.mutation).toBe(0);
    expect(stub.calls.detail).toBe(1);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it.each([
    ["completed", "Done"],
    ["canceled", "Canceled"],
  ])("an issue already in a %s state is recorded conflicted and never overwritten", async (type, label) => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [issuePayload({ state: { id: label === "Done" ? "s-done" : "s-canceled", name: label, type } })],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);
    expect(stub.calls.states).toBe(0); // guards run before any team-state read and write
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger).toMatchObject({ state: "conflicted", lastErrorCode: "conflicted" });
    expect(ledger?.note).toMatch(new RegExp(label, "i"));
  });

  it("an issue moved to another team is recorded conflicted and never overwritten", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [issuePayload({ teamId: "team-ops", teamKey: "OPS" })],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);
    expect(stub.calls.states).toBe(0);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({ state: "conflicted", lastErrorCode: "conflicted" });
  });

  it("a state-identity change between Helm's two reads conflicts (primary signal, F5)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload({ updatedAt: "t1" }),
        issuePayload({ updatedAt: "t2-someone-else-touched", state: { id: "s-review", name: "In Review", type: "started" } }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);
    expect(stub.calls.detail).toBe(2);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "conflicted",
      lastErrorCode: "conflicted",
      observedStateId: "s-review",
    });
  });

  it("a cosmetic-only change between the two reads (same state) no longer silently stalls the sync (F5)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload({ updatedAt: "t1", title: "Linear sync (before a comment)" }),
        issuePayload({ updatedAt: "t2-a-label-was-added", title: "Linear sync (after a comment)" }),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t3" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    // The state identity is unchanged; only updatedAt moved (a comment/label).
    // The sync proceeds and records synced from the post-write re-read instead
    // of silently stalling as a cosmetic-conflicted row.
    expect(result.outcome).toBe("synced");
    expect(stub.calls.mutation).toBe(1);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "synced",
      targetStateId: "s-progress",
    });
  });

  it("a Done state observed after the write is conflicted instead of confirmed", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-done", name: "Done", type: "completed" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "conflicted",
      observedStateId: "s-done",
    });
    expect(result.detail).toMatch(/never sets Done|Done/i);
  });

  it.each([
    ["missing", { connection: false }],
    ["expired", { accessExpiresAt: Date.now() - 1000 }],
    ["revoked", { status: "reauthorizationRequired" }],
  ])("a %s Linear authorization records authorization_required without crashing", async (_label, config) => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    if (config.connection !== false) await seedLinearConnection(t, config as { accessExpiresAt?: number; status?: string });
    const association = await seedAssociation(t, t3);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sync(t);
    expect(result.outcome).toBe("authorization_required");
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "authorization_required",
      lastErrorCode: "authorization_required",
      attemptCount: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves the target state from the issue's OWN team, never a global default", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    // Two mappings, two teams, two different started states.
    await seedMapping(t, t3);
    await seedMapping(t, t3, {
      linearTeamId: "team-ops", linearTeamKey: "OPS", linearTeamName: "Operations",
      startedStateId: "s-ops-start", startedStateName: "Ops Flow",
    });
    await seedLinearConnection(t);
    // F1: the sync is scoped to associations bound to the resolved identity,
    // so this OPS-targeted sync needs its association bound to the OPS team.
    const association = await seedAssociation(t, t3, { linearTeamId: "team-ops" });
    const stub = installLinearStub({
      // Every detail frame is an OPS issue; the ENG mapping's started state
      // must never be reached.
      details: [
        issuePayload({ teamId: "team-ops", teamKey: "OPS", state: { id: "s-ops-todo", name: "Ops Todo", type: "unstarted" } }),
        issuePayload({ teamId: "team-ops", teamKey: "OPS", state: { id: "s-ops-todo", name: "Ops Todo", type: "unstarted" } }),
        issuePayload({ teamId: "team-ops", teamKey: "OPS", state: { id: "s-ops-start", name: "Ops Flow", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_OPS,
    });

    const result = await sync(t, { linearTeamId: "team-ops" });
    expect(result.outcome).toBe("synced");
    // The write and the ledger carry the OPS team's state, resolved live —
    // not the ENG mapping's and not a hardcoded "In Progress" name.
    expect(stub.mutationArgs[0]).toEqual({ issueId: ISSUE_ID, stateId: "s-ops-start" });
    const ledger = (await ledgerOf(t, association.associationId))!;
    expect(ledger.targetStateId).toBe("s-ops-start");
    expect(ledger.targetStateName).toBe("Ops Flow");
  });

  it("a stale mapped started state is a CONFIGURATION stop, never a retryable failure (F7)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [issuePayload()],
      teamStates: TEAM_STATES_INVALID, // ENG offers no started state anymore
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger?.note).toMatch(/remap/i);
    // A misconfigured mapping fails identically on EVERY identical retry: it
    // is classified conflicted/misconfigured, not `retryable`/`read_failed`.
    expect(ledger).toMatchObject({ state: "conflicted", lastErrorCode: "misconfigured" });
  });

  it("refuses to sync an issue with no accepted launch association", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await expect(sync(t)).rejects.toThrow(/no accepted Helm launch to sync/);
  });

  it("a failing sync never causes a T3 launch attempt anywhere", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedAssociation(t, t3);
    installLinearStub({
      details: [issuePayload({ teamId: "team-ops", teamKey: "OPS" })], // conflicted path
    });
    await sync(t);
    await sync(t);
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => await ctx.db.query("linearAuthAttempts").collect())).toHaveLength(0);
  });

  it("exposes the ledger to the owner without leaking other owners' rows", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const ledgerRows = await authed.action(api.linearSync.ledgerForIssue, { linearIssueId: ISSUE_ID });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ associationId: association.associationId, state: "pending" });
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(other.action(api.linearSync.ledgerForIssue, { linearIssueId: ISSUE_ID })).rejects.toThrow(/unauthorized/);
  });

  it("a 200-with-errors ISSUE READ is uncertain and never trusted to write (F3)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const partialRead: unknown = {
      // HTTP 200, data present, but the read carries GraphQL errors: exactly
      // the partial response shape the write path must reject.
      errors: [{ message: "GraphQL reported a partial issue read" }],
      ...issuePayload(),
    };
    const stub = installLinearStub({
      details: [partialRead],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("retryable");
    expect(stub.calls.mutation).toBe(0); // no write can ride a partial read
    expect(stub.calls.states).toBe(0); // the stop happens before team states even matters
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "retryable",
      lastErrorCode: "graph_ql_errors",
    });
  });

  it("an issueStateUpdate success=false is a definite refusal filed write_rejected, not unreachable (F4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload(), // re-read still shows the old state
      ],
      teamStates: TEAM_STATES_ENG,
      mutationResponse: { data: { issueStateUpdate: { success: false } } },
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(1);
    const ledger = await ledgerOf(t, association.associationId);
    // "unreachable" was a network code for a refusal; the structured result
    // is now classified for what it is.
    expect(ledger).toMatchObject({
      state: "conflicted",
      lastErrorCode: "write_rejected",
      observedStateId: "s-backlog",
    });
  });

  it("a human's move to another state since the last observation is conflicted, never overwritten (F6)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);

    // First sync: the issue is shepherded into the team's In Progress state
    // and the ledger records the observed truth.
    const first = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    expect((await sync(t)).outcome).toBe("synced");
    expect(first.calls.mutation).toBe(1);

    // A human then deliberately moves it to another started state. The
    // conflict HOLDS the previous observation (sticky, N1): the ledger's
    // observed state stays In Progress, so the human's move is never
    // re-recorded as the new normal.
    const second = installLinearStub({
      details: [issuePayload({ state: { id: "s-review", name: "In Review", type: "started" }, updatedAt: "t3" })],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(second.calls.mutation).toBe(0);
    const ledger = (await ledgerOf(t, association.associationId))!;
    expect(ledger).toMatchObject({ state: "conflicted", observedStateId: "s-progress" });
    expect(ledger?.note).toContain("In Review");
  });

  it("the human-intent verdict is STICKY: the third sync after a deliberate move still refuses to write (N1)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);

    // Sync #1: shepherded into In Progress; the ledger's observation baseline
    // is the team's In Progress state.
    const first = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    expect((await sync(t)).outcome).toBe("synced");
    expect(first.calls.mutation).toBe(1);

    // A human deliberately moves the issue to In Review. Syncs #2 AND #3 must
    // both refuse: the conflicted outcome must NEVER advance the observation
    // baseline to the human's state (that advance used to let sync #3
    // overwrite the deliberate move — the exact regression this test pins).
    const humanState = issuePayload({ state: { id: "s-review", name: "In Review", type: "started" }, updatedAt: "t3" });
    const second = installLinearStub({ details: [humanState], teamStates: TEAM_STATES_ENG });
    expect((await sync(t)).outcome).toBe("conflicted");
    expect(second.calls.mutation).toBe(0);
    vi.unstubAllGlobals();

    const third = installLinearStub({ details: [humanState], teamStates: TEAM_STATES_ENG });
    const thirdResult = await sync(t);
    expect(thirdResult.outcome).toBe("conflicted");
    expect(third.calls.mutation).toBe(0); // the THIRD sync still writes nothing

    const ledger = (await ledgerOf(t, association.associationId))!;
    // Both conflicts HELD the baseline at In Progress — including the second
    // conflict, which was the bug.
    expect(ledger).toMatchObject({
      state: "conflicted",
      observedStateId: "s-progress",
      observedStateName: "In Progress",
      attemptCount: 3,
    });
    expect(ledger?.note).toContain("In Review");
  });

  it("a human's move OUT of a started state (back to Backlog) is also intent and is never overwritten (N2)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);

    const first = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    expect((await sync(t)).outcome).toBe("synced");
    expect(first.calls.mutation).toBe(1);

    // A human drags the issue back to Backlog (an `unstarted` state). The old
    // guard only looked at `started` states and would overwrite exactly this.
    const humanState = issuePayload({ state: { id: "s-backlog", name: "Backlog", type: "unstarted" }, updatedAt: "t3" });
    const second = installLinearStub({ details: [humanState], teamStates: TEAM_STATES_ENG });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(second.calls.mutation).toBe(0);

    // Sticky (N1): a repeat sync keeps refusing the same way.
    vi.unstubAllGlobals();
    const third = installLinearStub({ details: [humanState], teamStates: TEAM_STATES_ENG });
    expect((await sync(t)).outcome).toBe("conflicted");
    expect(third.calls.mutation).toBe(0);
    const ledger = (await ledgerOf(t, association.associationId))!;
    expect(ledger).toMatchObject({ state: "conflicted", observedStateId: "s-progress", attemptCount: 3 });
    expect(ledger?.note).toContain("Backlog");
  });

  it("ambiguous recorded baselines fail closed: conflicted and no write (N3)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const a = await seedAssociation(t, t3);
    const b = await seedAssociation(t, t3, {
      t3ThreadId: testThreadId(2),
      attemptId: "attempt-2",
      correlationKey: `[helm:${ISSUE_ID}:testcorrattempt-2]`,
    });

    // Two associations scoped to the SAME (project, team, issue) whose last
    // recorded observations disagree — Helm cannot tell which state was last
    // intended, so it must never skip the guard.
    await t.mutation(internal.linearSyncStore.recordSyncOutcome, {
      ...owner, associationIds: [a.associationId], linearProjectId: "proj-1", linearTeamId: "team-eng",
      state: "conflicted", errorCode: "conflicted",
      targetStateId: "s-progress", targetStateName: "In Progress",
      observedStateId: "s-backlog", observedStateName: "Backlog", observedStateType: "unstarted",
      at: Date.now(),
    });
    await t.mutation(internal.linearSyncStore.recordSyncOutcome, {
      ...owner, associationIds: [b.associationId], linearProjectId: "proj-1", linearTeamId: "team-eng",
      state: "conflicted", errorCode: "conflicted",
      targetStateId: "s-progress", targetStateName: "In Progress",
      observedStateId: "s-review", observedStateName: "In Review", observedStateType: "started",
      at: Date.now(),
    });

    const stub = installLinearStub({ details: [issuePayload()] });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);

    // Fail closed did not corrupt the evidence: each row HELD its own last
    // observed state, and the note names the ambiguity.
    expect(await ledgerOf(t, a.associationId)).toMatchObject({
      state: "conflicted", observedStateId: "s-backlog",
    });
    expect(await ledgerOf(t, b.associationId)).toMatchObject({
      state: "conflicted", observedStateId: "s-review",
    });
    expect((await ledgerOf(t, a.associationId))?.note).toContain("ambiguous");
  });

  it("a concurrent move INTO the target between the two reads is synced from observed truth, with no write (N4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [
        issuePayload({ updatedAt: "t1" }),
        // Between Helm's two reads, someone moved the issue exactly where
        // Helm wanted it. That is not a conflict.
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });

    const result = await sync(t);
    expect(result.outcome).toBe("synced");
    expect(stub.calls.mutation).toBe(0); // no write — the issue is already there
    expect(stub.calls.states).toBe(1); // only the target-state resolution read; no state-write ran
    expect(stub.calls.detail).toBe(2);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({
      state: "synced",
      targetStateId: "s-progress",
      targetStateName: "In Progress",
      observedStateId: "s-progress",
      lastErrorCode: null,
    });
    expect((await ledgerOf(t, association.associationId))?.note).toContain("Between Helm's two reads");
  });

  it("the ledger never marks a sibling team's association synced under this team's sync (F1)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const eng = await seedAssociation(t, t3);
    // A second association for the SAME issue id bound to a DIFFERENT
    // (project, team): the case that used to be overwritten wholesale.
    await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner,
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-2",
      linearTeamId: "team-ops",
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-762",
      t3ConnectionId: t3,
      t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-2",
      t3ThreadId: testThreadId(2),
      attemptId: "attempt-2",
      correlationKey: `[helm:${ISSUE_ID}:testcorrattempt-2]`,
      at: Date.now(),
    });
    const opsRow = await t.query(internal.linearAssociationStore.associationsForIssue, {
      ...owner, linearIssueId: ISSUE_ID, linearProjectId: "proj-2", linearTeamId: "team-ops",
    });
    const opsAssociationId = opsRow[0]!.associationId;
    // N5: a THIRD sibling in the SAME team but a DIFFERENT project — the
    // project half of the F1 filter is what this exercises. Dropping only the
    // `linearProjectId` comparison used to keep every test green.
    const sameTeam = await seedAssociation(t, t3, {
      linearProjectId: "proj-3",
      t3ProjectId: "t3-proj-3",
      t3ThreadId: testThreadId(3),
      attemptId: "attempt-3",
      correlationKey: `[helm:${ISSUE_ID}:testcorrattempt-3]`,
    });

    const stub = installLinearStub({
      details: [
        issuePayload(),
        issuePayload(),
        issuePayload({ state: { id: "s-progress", name: "In Progress", type: "started" }, updatedAt: "t2" }),
      ],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t); // syncIssue(proj-1, team-eng)
    expect(result.outcome).toBe("synced");
    expect(stub.calls.mutation).toBe(1);

    // The ENG association the sync was resolved under records synced with the
    // ENG target state...
    expect(await ledgerOf(t, eng.associationId)).toMatchObject({
      state: "synced",
      targetStateId: "s-progress",
      targetStateName: "In Progress",
    });
    // ...while the OPS sibling keeps its own pending row: its team NEVER
    // disagrees with a target state that was recorded for it.
    expect(await ledgerOf(t, opsAssociationId)).toMatchObject({
      state: "pending",
      lastErrorCode: null,
      targetStateId: null,
      observedStateId: null,
      attemptCount: 0,
    });
    // ...and so does the SAME-TEAM / DIFFERENT-PROJECT sibling (N5).
    expect(await ledgerOf(t, sameTeam.associationId)).toMatchObject({
      state: "pending",
      lastErrorCode: null,
      targetStateId: null,
      observedStateId: null,
      attemptCount: 0,
    });
  });

  it("openLedger exposes the operator work queue by the by_state index; synced rows never appear (F8)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    // Drive two deliberate retries against a raw-429 write handler: every
    // state-write is refused with 429, so linearJson surfaces
    // `Linear request failed (429)` and the ledger stays retryable.
    const calls = { detail: 0, states: 0, mutation: 0 };
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, string> };
      if (String(input) !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected target: ${String(input)}`);
      if (body.query.startsWith("mutation")) {
        calls.mutation += 1;
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_TEAM_STATES_QUERY) {
        calls.states += 1;
        return new Response(JSON.stringify(TEAM_STATES_ENG), { status: 200, headers: { "content-type": "application/json" } });
      }
      calls.detail += 1;
      return new Response(JSON.stringify(issuePayload()), { status: 200, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetchStub);
    expect((await sync(t)).outcome).toBe("retryable");
    expect((await sync(t)).outcome).toBe("retryable");
    expect(calls.mutation).toBe(2);
    expect(calls.detail).toBeGreaterThan(0); // the issue was re-read every attempt

    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const queue = await authed.action(api.linearSync.openLedger, {});
    expect(queue.open).toHaveLength(1); // the synced association is out of the queue
    expect(queue.open[0]).toMatchObject({
      associationId: association.associationId,
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-762",
      state: "retryable",
      lastErrorCode: "rate_limited",
    });
    expect(queue.recordingFailures).toEqual([]);
    await expect(t.action(api.linearSync.openLedger, {})).rejects.toThrow(/unauthorized/);
  });

  it("openLedger orders by actionability with a per-state budget: a conflicted row surfaces among a FULL pending budget (N7)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);

    // A full pending budget: 200 pending ledger rows over distinct issues.
    for (let i = 0; i < 200; i += 1) {
      await seedAssociation(t, t3, {
        linearIssueId: `issue-bulk-${i}`,
        linearIssueIdentifier: `EGA-${1000 + i}`,
        t3ThreadId: testThreadId(i + 10),
        attemptId: `attempt-bulk-${i}`,
        correlationKey: `[helm:issue-bulk-${i}:corr-${i}]`,
      });
    }
    // One actionable row on top of the saturated pending budget.
    await t.mutation(internal.linearSyncStore.recordSyncOutcome, {
      ...owner, associationIds: [association.associationId], linearProjectId: "proj-1", linearTeamId: "team-eng",
      state: "conflicted", errorCode: "conflicted",
      targetStateId: "s-progress", targetStateName: "In Progress",
      observedStateId: "s-review", observedStateName: "In Review", observedStateType: "started",
      note: "A human appears to have moved the issue.",
      at: Date.now(),
    });

    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const queue = await authed.action(api.linearSync.openLedger, {});
    // The conflicted row comes FIRST — starvation by `pending` is the bug.
    expect(queue.open[0]).toMatchObject({
      associationId: association.associationId,
      state: "conflicted",
      linearIssueId: ISSUE_ID,
    });
    // The pending class keeps its own full budget behind it.
    const pendingRows = queue.open.filter((row) => row.state === "pending");
    expect(pendingRows).toHaveLength(200);
    expect(pendingRows[0].linearIssueId).not.toBe(ISSUE_ID);
  });
});
