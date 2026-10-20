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

  async function seedAssociation(t: ReturnType<typeof convexTest>, t3ConnectionId: Id<"t3Connections">) {
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

  it("an issue externally changed between Helm's two reads is conflicted and never written", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedAssociation(t, t3);
    const stub = installLinearStub({
      details: [issuePayload({ updatedAt: "t1" }), issuePayload({ updatedAt: "t2-someone-else-touched" })],
      teamStates: TEAM_STATES_ENG,
    });
    const result = await sync(t);
    expect(result.outcome).toBe("conflicted");
    expect(stub.calls.mutation).toBe(0);
    expect(stub.calls.detail).toBe(2);
    expect(await ledgerOf(t, association.associationId)).toMatchObject({ state: "conflicted", lastErrorCode: "conflicted" });
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
    const association = await seedAssociation(t, t3);
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

  it("records retryable when the mapped started state is no longer valid for the team", async () => {
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
    expect(result.outcome).toBe("retryable");
    expect(stub.calls.mutation).toBe(0);
    const ledger = await ledgerOf(t, association.associationId);
    expect(ledger?.note).toMatch(/remap/i);
    expect(ledger?.state).not.toBe("synced");
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
});
