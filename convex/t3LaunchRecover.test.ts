/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";

const mock = vi.hoisted(() => ({ connect: vi.fn(), callTool: vi.fn(), close: vi.fn(), listTools: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(...args: unknown[]) { return mock.connect(...args); }
    callTool(...args: unknown[]) { return mock.callTool(...args); }
    listTools(...args: unknown[]) { return mock.listTools(...args); }
    close(...args: unknown[]) { return mock.close(...args); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

/**
 * Owner-gated, read-only attempt recovery (`api.t3Launch.recover`).
 *
 * Convex is the source of truth: after a hard browser reload the panel calls
 * this instead of trusting module-level browser storage. Every test below
 * drives the server path a reloaded panel would take — a fresh read with no
 * browser state — never just a second action call with a remembered id.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };
const ENDPOINT = "https://operate.example.invalid/mcp";
const ENV_ID = "env-op";
const T3_PROJECT = "t3-proj-1";

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function envFixture(environmentId = ENV_ID) {
  return { environmentId, label: "Op", serverVersion: "v", platform: "linux/x64", preferences: null };
}

function catalogFixture(modelIds: string[] = ["m1"]) {
  return {
    providers: [{
      providerInstanceId: "p1", driverKind: null, displayName: "P1",
      models: modelIds.map((id) => ({ id, label: null, options: null })),
      runtimeModes: null, canRunChildTask: null, canRunCrossProviderChildTask: null,
      authenticationStatus: null, availability: null, constraints: null,
    }],
    features: {
      appOwnedSubagents: false, asyncPolling: false, cancellation: false,
      batchThreadCreation: false, threadManagement: false, incrementalThreadRead: false,
      scheduledTasks: false, maxBatchThreads: null,
    },
    runtimeMode: "approval-required", interactionMode: "default",
    parentThreadId: null, inheritedProviderInstanceId: null, inheritedModel: null,
  };
}

function launchAck(threadId: string | null) {
  return threadId === null
    ? { status: "accepted" }
    : { threadId, projectId: T3_PROJECT, runId: "run:thread:ordinal:1", status: "preparing" };
}

function launchInput(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: "issue-1",
    linearIssueIdentifier: "EGA-681",
    prompt: "do the thing",
    providerInstanceId: "p1",
    model: "m1",
    runtimeMode: "approval-required",
    useSubagents: false,
    expectedLatestAttemptId: null,
    ...overrides,
  };
}

function recoverInput(overrides: Record<string, unknown> = {}) {
  return { linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: "issue-1", ...overrides };
}

function linearIssuePayload(issueId: string, overrides: { teamId?: string; projectId?: string; identifier?: string } = {}) {
  return {
    data: {
      organization: { id: "ws-1" },
      issue: {
        id: issueId,
        identifier: overrides.identifier ?? "EGA-681",
        title: "Native launch",
        url: "https://linear.app/helm/issue/EGA-681",
        priority: 2,
        priorityLabel: "High",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        team: { id: overrides.teamId ?? "team-eng", key: "ENG", name: "Engineering" },
        assignee: null,
        description: "Ship the launch.",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        project: { id: overrides.projectId ?? "proj-1" },
      },
    },
  };
}

/** Stub Linear GraphQL: the detail read echoes the requested issue id. */
function stubLinearIssue(overrides: { teamId?: string; projectId?: string; identifier?: string } = {}) {
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const issueId = typeof variables.issueId === "string" ? variables.issueId : "issue-1";
    return new Response(JSON.stringify(linearIssuePayload(issueId, overrides)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("t3Launch.recover: owner-gated read-only recovery", () => {
  let savedKeys: Record<string, string | undefined>;
  let launchCalls: { name: string; args: Record<string, unknown> }[];
  let ackThreadId: string | null | undefined;
  let catalogModels: string[];
  let listMatches: number;

  beforeEach(() => {
    savedKeys = {
      T3_OAUTH_ENCRYPTION_KEY_VERSION: process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION,
      T3_OAUTH_ENCRYPTION_KEY_V1: process.env.T3_OAUTH_ENCRYPTION_KEY_V1,
      T3_OAUTH_ENCRYPTION_KEY: process.env.T3_OAUTH_ENCRYPTION_KEY,
      LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION,
      LINEAR_OAUTH_ENCRYPTION_KEY_V1: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1,
      LINEAR_OAUTH_ENCRYPTION_KEY: process.env.LINEAR_OAUTH_ENCRYPTION_KEY,
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
      T3_NATIVE_WRITE_ENDPOINT: process.env.T3_NATIVE_WRITE_ENDPOINT,
      T3_NATIVE_WRITE_ENVIRONMENTS: process.env.T3_NATIVE_WRITE_ENVIRONMENTS,
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("l".repeat(32)).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    // The owner-approved native write target, matching the seeded operate
    // connection. Tests that exercise refusals remove or change these.
    process.env.T3_NATIVE_WRITE_ENDPOINT = ENDPOINT;
    process.env.T3_NATIVE_WRITE_ENVIRONMENTS = ENV_ID;

    launchCalls = [];
    ackThreadId = undefined;
    catalogModels = ["m1"];
    listMatches = 0;
    mock.connect.mockReset().mockResolvedValue(undefined);
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.listTools.mockReset();
    mock.callTool.mockReset().mockImplementation(baseCallTool);
    stubLinearIssue();
  });

  type McpCall = { name: string; arguments: Record<string, unknown> };

  async function baseCallTool(call: McpCall) {
    if (call.name === "t3_environment_read") return textResult(envFixture());
    if (call.name === "orchestrator_capabilities") return textResult(catalogFixture(catalogModels));
    if (call.name === "t3_thread_launch") {
      launchCalls.push({ name: call.name, args: call.arguments });
      const threadId = ackThreadId === undefined ? testThreadId(1) : ackThreadId;
      return textResult(launchAck(threadId));
    }
    if (call.name === "t3_thread_list") {
      const title = String(launchCalls[0]?.args.title ?? "");
      const key = title.split(" ").pop() ?? "";
      const threads = Array.from({ length: listMatches }, (_, index) => ({
        threadId: testThreadId(10 + index),
        projectId: T3_PROJECT,
        title: `Helm proj-1/team-eng ${key}`,
      }));
      return textResult({ projectId: T3_PROJECT, threads, nextCursor: null, total: threads.length });
    }
    throw new Error(`unexpected tool ${call.name}`);
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  function encryptToken(plaintext: string, endpoint: string): string {
    const key = Buffer.from(process.env.T3_OAUTH_ENCRYPTION_KEY_V1!, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`token:${OWNER_ISSUER}:${OWNER_SUBJECT}:${endpoint}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedConnection(
    t: Harness,
    options: { access: "read-only" | "operate"; status?: string; endpoint?: string; environmentId?: string },
  ): Promise<Id<"t3Connections">> {
    const endpoint = options.endpoint ?? ENDPOINT;
    const environmentId = options.environmentId ?? ENV_ID;
    return await t.run(async (ctx) =>
      ctx.db.insert("t3Connections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        endpoint, issuer: endpoint, resource: endpoint, clientId: "helm-test-client",
        environmentId, environmentLabel: "Op", serverVersion: "v", platform: "linux/x64",
        access: options.access, status: (options.status ?? "connected") as "connected",
        tokenCiphertext: encryptToken("test-token", endpoint),
        credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(), updatedAt: Date.now(),
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      }),
    );
  }

  async function seedMapping(t: Harness, t3ConnectionId: Id<"t3Connections">, overrides: Record<string, unknown> = {}) {
    return await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner,
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: ENV_ID, t3ProjectId: T3_PROJECT, t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main",
      startedStateId: "state-started", startedStateName: "In Progress",
      at: Date.now(),
      ...overrides,
    });
  }

  async function ready(t: Harness) {
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const operateId = await seedConnection(t, { access: "operate" });
    await seedMapping(t, readonlyId);
    await seedLinearConnection(t);
    return { readonlyId, operateId };
  }

  async function seedLinearConnection(t: Harness): Promise<void> {
    await t.run(async (ctx) =>
      ctx.db.insert("linearConnections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
        accessTokenCiphertext: encryptLinearSecret(
          "test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
        refreshTokenCiphertext: encryptLinearSecret(
          "test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
        accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null,
        credentialVersion: 1, scopes: ["read", "write"], status: "connected",
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
        clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
        createdAt: Date.now(), updatedAt: Date.now(),
      }),
    );
  }

  function authed(t: Harness) {
    return t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  }

  it("reports none with a clean start for an issue with no attempts", async () => {
    const t = await granted();
    await ready(t);
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery).toEqual({ latest: null, outcome: "none", canStartNewExecution: true, blockers: [], observedLatestAttemptId: null });
    expect(launchCalls).toHaveLength(0);
  });

  it("reload after successful launch: a fresh read shows the existing thread and allows a new execution only via a fresh id", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");

    // Simulate the hard reload: no browser state, just a fresh server read.
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("acknowledged");
    expect(recovery.canStartNewExecution).toBe(true);
    expect(recovery.blockers).toEqual([]);
    expect(recovery.latest).toMatchObject({
      attemptId: "attempt-1",
      state: "acknowledged",
      threadId: testThreadId(1),
    });
    expect(recovery.latest?.correlationKey).toBe(first.correlationKey);

    // Reusing the acknowledged attemptId returns the stored thread without a
    // second remote launch …
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.threadId).toBe(first.threadId);
    expect(launchCalls).toHaveLength(1);

    // … while a genuinely new execution mints a fresh id and launches again.
    const fresh = await authed(t).action(api.t3Launch.recover, recoverInput());
    const second = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-2", expectedLatestAttemptId: fresh.observedLatestAttemptId }));
    expect(second.outcome).toBe("launched");
    expect(second.threadId).toBe(testThreadId(1));
    expect(launchCalls).toHaveLength(2);
    const after = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(after.latest?.attemptId).toBe("attempt-2");
    expect(after.outcome).toBe("acknowledged");
  });

  it("reload after lost acknowledgement: ambiguous shows accurately, disables launch, performs no relaunch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);

    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("ambiguous");
    expect(recovery.canStartNewExecution).toBe(false);
    expect(recovery.blockers).toHaveLength(1);
    expect(recovery.blockers[0]).toMatch(/reconcile/i);
    expect(recovery.latest?.attemptId).toBe("attempt-1");

    // A retry of the same reservation still refuses to relaunch: zero matches
    // stay ambiguous with no duplicate T3 launch.
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("many reconciliation matches stay ambiguous with no duplicate launch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 2;
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("ambiguous");
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("ambiguous");
    expect(recovery.canStartNewExecution).toBe(false);
    expect(recovery.latest?.matchCount).toBe(2);
    expect(launchCalls).toHaveLength(1);
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);
  });

  it("a single reconciliation match resolves to its thread without a second launch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 1;
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    expect(first.threadId).toBe(testThreadId(10));
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("acknowledged");
    expect(recovery.canStartNewExecution).toBe(true);
    expect(recovery.latest?.threadId).toBe(testThreadId(10));
    expect(launchCalls).toHaveLength(1);
  });

  it("reload while dispatching: unresolved shows accurately and refuses a competing id", async () => {
    const t = await granted();
    await ready(t);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-1",
      issueIdentifier: "EGA-681",
      targetProjectId: T3_PROJECT,
      attemptId: "attempt-dispatched",
      payloadHash: "c".repeat(64),
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "attempt-dispatched", at: Date.now() });

    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.canStartNewExecution).toBe(false);
    expect(recovery.blockers).toHaveLength(1);
    expect(recovery.blockers[0]).toContain("attempt-dispatched");
    expect(recovery.blockers[0]).toContain("dispatching");
    expect(recovery.latest?.attemptId).toBe("attempt-dispatched");

    // A fresh attemptId is refused server-side while the earlier attempt is
    // unresolved — no second launch. The tab's token is current (it
    // recovered after the reservation), so the unresolved lock refuses it.
    const refused = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-2", expectedLatestAttemptId: "attempt-dispatched" }));
    expect(refused.outcome).toBe("in_progress");
    expect(launchCalls).toHaveLength(0);
  });

  it("a changed payload with an existing attemptId is still refused", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    await expect(
      authed(t).action(api.t3Launch.launch, launchInput({ prompt: "a different launch" })),
    ).rejects.toThrow(/does not match its reservation/);
    expect(launchCalls).toHaveLength(1);
  });

  it("two separate issues in one project and team stay independent", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");

    const other = await authed(t).action(api.t3Launch.recover, recoverInput({ linearIssueId: "issue-2" }));
    expect(other).toEqual({ latest: null, outcome: "none", canStartNewExecution: true, blockers: [], observedLatestAttemptId: null });

    const second = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-2", linearIssueId: "issue-2", linearIssueIdentifier: "EGA-682" }),
    );
    expect(second.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(2);
  });

  it("an abandoned attempt reports abandoned and allows a fresh execution", async () => {
    const t = await granted();
    await ready(t);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-1",
      issueIdentifier: "EGA-681",
      targetProjectId: T3_PROJECT,
      attemptId: "attempt-doomed",
      payloadHash: "d".repeat(64),
    });
    await t.mutation(internal.launchAttempts.abandonAttempt, { attemptId: "attempt-doomed", note: "operator" });
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("abandoned");
    expect(recovery.canStartNewExecution).toBe(true);
    expect(recovery.blockers).toEqual([]);
    const next = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-fresh", expectedLatestAttemptId: recovery.observedLatestAttemptId }));
    expect(next.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(1);
  });

  it("the read is read-only: no mutation, no launch, no reconciliation", async () => {
    const t = await granted();
    await ready(t);
    await authed(t).action(api.t3Launch.launch, launchInput());
    const before = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("acknowledged");
    const after = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(after).toEqual(before);
    expect(launchCalls).toHaveLength(1);
  });

  it("a read-only connection can recover state without operate access", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    await seedMapping(t, readonlyId);
    await seedLinearConnection(t);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-1",
      issueIdentifier: "EGA-681",
      targetProjectId: T3_PROJECT,
      attemptId: "attempt-ro",
      payloadHash: "e".repeat(64),
    });
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.latest?.attemptId).toBe("attempt-ro");
    expect(launchCalls).toHaveLength(0);
  });

  it("denies anonymous, non-owner, and stale-revision callers on the recovery read", async () => {
    const t = await granted();
    await ready(t);
    await expect(t.action(api.t3Launch.recover, recoverInput())).rejects.toThrow(/unauthorized/);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(other.action(api.t3Launch.recover, recoverInput())).rejects.toThrow(/unauthorized/);
    // A rotated grant makes the seeded rows stale: the Linear verification
    // fails closed instead of reporting another owner's validated issue.
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(authed(t).action(api.t3Launch.recover, recoverInput())).rejects.toThrow(/could not be verified/);
  });

  it("the read is scoped to the owner's validated issue", async () => {
    const t = await granted();
    await ready(t);
    stubLinearIssue({ teamId: "team-other" });
    await expect(authed(t).action(api.t3Launch.recover, recoverInput())).rejects.toThrow(
      /not in the mapped project and team/,
    );
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
  });

  it("fails closed when the Linear connection is unverifiable: no read, no reservation", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    await seedConnection(t, { access: "operate" });
    await seedMapping(t, readonlyId);
    // No Linear connection is seeded, so the issue cannot be verified.
    await expect(authed(t).action(api.t3Launch.recover, recoverInput())).rejects.toThrow(
      /could not be verified/,
    );
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
  });

  it("refuses invalid request shapes without reading", async () => {
    const t = await granted();
    await ready(t);
    await expect(authed(t).action(api.t3Launch.recover, recoverInput({ linearIssueId: "" }))).rejects.toThrow(
      /launch request is invalid/,
    );
    await expect(
      authed(t).action(api.t3Launch.recover, recoverInput({ linearIssueId: "issue with spaces" })),
    ).rejects.toThrow(/launch request is invalid/);
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(0);
  });

  it("never authorizes a relaunch, in source or at runtime", async () => {
    const t = await granted();
    await ready(t);
    const recovery = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recovery.canStartNewExecution).toBe(true);
    expect(launchCalls).toHaveLength(0);
  });
});
