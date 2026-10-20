/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { operateToolCall } from "./t3OAuth";
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
 * Native launch contract (EGA-681 D07).
 *
 * There is NO live T3 connection here, so the launch path's live behaviour is
 * NOT tested: every remote call is served by the mocked MCP client above. What
 * IS proven: the permission boundary (read-only can never reach the write
 * tool, before any network call), the durable reservation (exists before
 * dispatch, binds the payload, decides retries), and the recovery rules (zero
 * or many matches stay ambiguous and never relaunch).
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
        team: {
          id: overrides.teamId ?? "team-eng",
          key: "ENG",
          name: "Engineering",
        },
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

describe("t3Launch: native worktree-thread launch", () => {
  let savedKeys: Record<string, string | undefined>;
  let launchCalls: { name: string; args: Record<string, unknown> }[];
  let ackThreadId: string | null | undefined;
  let catalogModels: string[];
  /** Threads the mocked list call reports as carrying the launched key. */
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
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("l".repeat(32)).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;

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

  /** Default MCP behaviour: every remote call succeeds off the closure fixtures. */
  async function baseCallTool(call: McpCall) {
    if (call.name === "t3_environment_read") return textResult(envFixture());
    if (call.name === "orchestrator_capabilities") return textResult(catalogFixture(catalogModels));
    if (call.name === "t3_thread_launch") {
      launchCalls.push({ name: call.name, args: call.arguments });
      const threadId = ackThreadId === undefined ? testThreadId(1) : ackThreadId;
      return textResult(launchAck(threadId));
    }
    if (call.name === "t3_thread_list") {
      // The launch call runs first and captures the launched title; the
      // reconciliation search runs after. Fabricate exactly `listMatches`
      // threads carrying the launched correlation key.
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

  it("launches through the operate connection with the reviewed payload and an explicit worktree strategy", async () => {
    const t = await granted();
    await ready(t);
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("launched");
    expect(result.reason).toBe(null);
    expect(result.relaunchAuthorized).toBe(false);
    expect(result.threadId).toBe(testThreadId(1));
    expect(result.attemptId).toBe("attempt-1");
    expect(result.correlationKey).toContain("issue-1");
    expect(launchCalls).toHaveLength(1);

    // The reservation existed BEFORE the dispatch: the launched title carries
    // the stored correlation key, which is minted only at reservation time.
    const stored = await t.query(internal.launchAttempts.getCorrelationForReconciliation, { attemptId: "attempt-1" });
    expect(stored?.correlationKey).toBe(result.correlationKey);
    expect(stored?.state).toBe("acknowledged");
    // The per-issue lock keys on the Linear issue id, never the project/team.
    expect(stored?.issueKey).toBe("issue-1");
    const row = await t.run(async (ctx) =>
      ctx.db.query("launchAttempts").withIndex("by_attempt_id", (q) => q.eq("attemptId", "attempt-1")).first());
    expect(row?.issueKey).toBe("issue-1");
    expect(row?.issueIdentifier).toBe("EGA-681");
    expect(launchCalls[0]!.args.title).toContain(result.correlationKey);
    expect(launchCalls[0]!.args).toMatchObject({
      projectId: T3_PROJECT,
      modelSelection: { instanceId: "p1", model: "m1" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      message: "do the thing",
    });
    const strategy = launchCalls[0]!.args.workspaceStrategy as Record<string, unknown>;
    expect(strategy).toMatchObject({ type: "worktree", baseRef: "refs/heads/main", startFromOrigin: false });
    expect(typeof strategy.branch).toBe("string");
    // The worktree branch slugs the human-readable issue identifier, with a
    // per-attempt hash suffix so a retry reuses the same branch.
    expect(strategy.branch).toMatch(/^helm\/ega-681-[0-9a-f]{8}$/);
  });

  it("a read-only connection can never reach the write tool, before any network call", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    await seedMapping(t, readonlyId);
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/operate access has not been granted/);
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("the write tool helper refuses a non-operate access before any network call", async () => {
    await expect(operateToolCall(ENDPOINT, "token", "read-only", "t3_thread_launch", {})).rejects.toThrow(
      /operate access is required/,
    );
    // NOTE: this example must stay OUTSIDE WRITE_TOOLS. It previously used
    // `t3_thread_send`, which became allowlisted when EGA-764/765 claimed their
    // share of the write contract — so the assertion silently stopped testing
    // anything. `t3_thread_fork` is not allocated to any issue in v0.2.
    await expect(operateToolCall(ENDPOINT, "token", "operate", "t3_thread_fork", {})).rejects.toThrow(
      /not available/,
    );
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("the same attemptId with a different payload is refused and never relaunches", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    await expect(
      authed(t).action(api.t3Launch.launch, launchInput({ prompt: "a different launch" })),
    ).rejects.toThrow(/does not match its reservation/);
    expect(launchCalls).toHaveLength(1);
  });

  it("a retry with the same attemptId and payload returns the stored thread without a second launch", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("launched");
    expect(retry.threadId).toBe(first.threadId);
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("a competing attemptId is refused while an earlier attempt for the same issue is unresolved", async () => {
    const t = await granted();
    await ready(t);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-1",
      issueIdentifier: "EGA-681",
      targetProjectId: T3_PROJECT,
      attemptId: "reserved-elsewhere",
      payloadHash: "c".repeat(64),
    });
    // The tab recovered after the reservation, so its token is current; the
    // unresolved lock (not the stale guard) is what refuses this launch.
    const result = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-2", expectedLatestAttemptId: "reserved-elsewhere" }));
    expect(result.outcome).toBe("in_progress");
    expect(result.detail).toMatch(/unresolved launch attempt/);
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
  });

  it("zero reconciliation matches stay ambiguous and never relaunch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    // A retry of the same reservation still refuses to relaunch.
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    // An abandoned reservation cannot be retried either: a new execution
    // needs a fresh attempt id.
    await t.mutation(internal.launchAttempts.abandonAttempt, { attemptId: "attempt-1" });
    await expect(authed(t).action(api.t3Launch.launch, launchInput())).rejects.toThrow(/abandoned/);
    expect(launchCalls).toHaveLength(1);
  });

  it("many reconciliation matches stay ambiguous and never relaunch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 2;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    const stored = await t.query(internal.launchAttempts.getCorrelationForReconciliation, { attemptId: "attempt-1" });
    expect(stored?.state).toBe("ambiguous");
    expect(stored?.matchCount).toBe(2);
    // A retry of the same reservation still refuses to relaunch.
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("a single reconciliation match resolves to its thread without a second launch", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 1;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("launched");
    expect(result.threadId).toBe(testThreadId(10));
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("a rejected launch is reconciled, never retried", async () => {
    const t = await granted();
    await ready(t);
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        throw new Error("T3 request failed (503)");
      }
      return baseCallTool(call);
    });
    listMatches = 0;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    // A retry of the same reservation still refuses to relaunch.
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);
  });

  it("a revoked grant mid-flight pauses the connection and stays ambiguous", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        throw new Error("T3 request failed (401)");
      }
      return baseCallTool(call);
    });
    listMatches = 0;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("ambiguous");
    expect(result.relaunchAuthorized).toBe(false);
    const rows = await t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() });
    expect(rows.find((row) => String(row.connectionId) === String(operateId))?.status).toBe("reauthorizationRequired");
    expect(launchCalls).toHaveLength(1);
  });

  it("denies anonymous, non-owner, and revoked callers", async () => {
    const t = await granted();
    await ready(t);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.t3Launch.launch, launchInput())).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.t3Launch.launch, launchInput())).rejects.toThrow(/unauthorized/);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed(t).action(api.t3Launch.launch, launchInput())).rejects.toThrow(/unauthorized/);
  });

  it("a stale grant revision makes the operate connection unusable", async () => {
    const t = await granted();
    await ready(t);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(launchCalls).toHaveLength(0);
  });

  it("refuses a model absent from the live catalogue", async () => {
    const t = await granted();
    await ready(t);
    catalogModels = ["other-model"];
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("model_unavailable");
    expect(result.detail).toMatch(/live T3 catalog/);
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
  });

  it("refuses an unmapped or disabled mapping with a specific reason", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    const unmapped = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-u", linearProjectId: "proj-unknown" }),
    );
    expect(unmapped.outcome).toBe("blocked");
    expect(unmapped.reason).toBe("authorization_required");
    expect(unmapped.detail).toMatch(/No enabled mapping/);
    expect(unmapped.relaunchAuthorized).toBe(false);

    const mappingId = await seedMapping(t, operateId, { linearProjectId: "proj-2", linearTeamId: "team-ops" });
    await t.mutation(internal.projectMappingsStore.disableMapping, { ...owner, mappingId, at: Date.now() });
    const disabled = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-d", linearProjectId: "proj-2", linearTeamId: "team-ops" }),
    );
    expect(disabled.outcome).toBe("blocked");
    expect(disabled.detail).toMatch(/No enabled mapping/);
    expect(launchCalls).toHaveLength(0);
  });

  it("refuses a mapping that points at a different T3 environment than the operate grant", async () => {
    const t = await granted();
    await seedConnection(t, { access: "operate" });
    const readonlyId = await seedConnection(t, { access: "read-only", environmentId: "env-other" });
    await seedMapping(t, readonlyId, { t3EnvironmentId: "env-other" });
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/different T3 environment/);
    expect(launchCalls).toHaveLength(0);
  });

  it("refuses a subagent review without launching", async () => {
    const t = await granted();
    await ready(t);
    await expect(
      authed(t).action(api.t3Launch.launch, launchInput({ useSubagents: true, subagentModel: "m1" })),
    ).rejects.toThrow(/Subagent preference cannot be forwarded/);
    expect(launchCalls).toHaveLength(0);
  });

  it("a second intentional execution with a fresh attemptId launches again", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    // Intentional second execution: the tab re-recovers first, so its token
    // is the now-current acknowledged attempt.
    const recovery = await authed(t).action(api.t3Launch.recover, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: "issue-1",
    });
    expect(recovery.observedLatestAttemptId).toBe("attempt-1");
    const second = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-2", expectedLatestAttemptId: recovery.observedLatestAttemptId }));
    expect(second.outcome).toBe("launched");
    expect(second.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(2);
  });

  it("never authorizes a relaunch, in source or at runtime", async () => {
    const src = readFileSync(join(import.meta.dirname, "t3Launch.ts"), "utf8");
    expect(src).not.toMatch(/relaunchAuthorized:\s*true/);
    // The only Linear surface is the authoritative issue read before any
    // reservation: a failed Linear sync must never trigger another launch,
    // and this action performs no Linear mutation.
    expect(src).toMatch(/linearIssues/);
    expect(src).not.toMatch(/linearOAuth|linearConnectionsStore/);
    // The per-issue lock keys on the Linear issue id.
    expect(src).toMatch(/issueKey: linearIssueId/);
  });

  it("two different issues in the same project and team can each reserve and launch", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    // A different issue in the SAME project+team is not a competing attempt:
    // the unresolved-attempt lock is per issue id.
    const second = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-2", linearIssueId: "issue-2", linearIssueIdentifier: "EGA-682" }),
    );
    expect(second.outcome).toBe("launched");
    expect(second.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(2);
    const rows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(rows.map((row) => row.issueKey).sort()).toEqual(["issue-1", "issue-2"]);
  });

  it("reload recovery: a fresh mount reusing the attemptId hits the same reservation without a second launch", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    // Simulate a reload: the persisted attempt record supplies the same
    // attemptId on the fresh mount. The stored row decides — same
    // correlationKey and thread, no second remote launch.
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("launched");
    expect(retry.attemptId).toBe(first.attemptId);
    expect(retry.correlationKey).toBe(first.correlationKey);
    expect(retry.threadId).toBe(first.threadId);
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("refuses an issue that is not in the mapped project and team, before any reservation", async () => {
    const t = await granted();
    await ready(t);
    stubLinearIssue({ teamId: "team-other" });
    const result = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-foreign" }));
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/not in the mapped project and team/);
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
    const rows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(rows).toHaveLength(0);
  });

  it("fails closed when the Linear connection is unverifiable: no launch, no reservation", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const operateId = await seedConnection(t, { access: "operate" });
    await seedMapping(t, readonlyId);
    void operateId;
    // No Linear connection is seeded, so the authoritative issue read
    // cannot verify the issue. The launch must stop before reserving.
    const result = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-unverified" }));
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("read_failed");
    expect(result.detail).toMatch(/could not be verified/);
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
    const rows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(rows).toHaveLength(0);
  });

  it("refuses invalid issue identity shapes without launching", async () => {
    const t = await granted();
    await ready(t);
    for (const bad of ["", "x".repeat(129), "issue with spaces", "issue/681"]) {
      await expect(
        authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-bad", linearIssueId: bad })),
      ).rejects.toThrow(/launch request is invalid/);
    }
    await expect(
      authed(t).action(
        api.t3Launch.launch,
        launchInput({ attemptId: "attempt-bad", linearIssueIdentifier: "EGA 681!" }),
      ),
    ).rejects.toThrow(/launch request is invalid/);
    expect(launchCalls).toHaveLength(0);
  });

  it("an acknowledged launch durably records exactly one association, without changing launch semantics (F9)", async () => {
    const t = await granted();
    await ready(t);
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("launched");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);

    const associations = await t.run(async (ctx) =>
      await ctx.db.query("linearIssueThreads").collect());
    expect(associations).toHaveLength(1);
    expect(associations![0]).toMatchObject({
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: "issue-1",
      t3ConnectionId: expect.anything(),
      t3EnvironmentId: ENV_ID,
      t3ProjectId: T3_PROJECT,
      t3ThreadId: result.threadId,
      attemptId: "attempt-1",
      correlationKey: result.correlationKey,
    });
    // The companion ledger row exists and is pending with zero attempted syncs.
    const ledgers = await t.run(async (ctx) => await ctx.db.query("linearSyncLedger").collect());
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      associationId: associations![0]!._id,
      state: "pending",
      attemptCount: 0,
    });
  });

  it("a retried launch (reused settled attempt) records NO extra association (F9)", async () => {
    const t = await granted();
    await ready(t);
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    const retry = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(retry.outcome).toBe("launched");
    expect(retry.threadId).toBe(first.threadId);
    expect(launchCalls).toHaveLength(1);
    const associations = await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect());
    const ledgers = await t.run(async (ctx) => await ctx.db.query("linearSyncLedger").collect());
    expect(associations).toHaveLength(1);
    expect(ledgers).toHaveLength(1);
    // The retry's launch outcome itself is unchanged from before F9.
    expect(retry.correlationKey).toBe(first.correlationKey);
  });

  it("a reconciled launch records its association once (F9)", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 1;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("launched");
    expect(result.threadId).toBe(testThreadId(10));
    const associations = await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect());
    expect(associations).toHaveLength(1);
    expect(associations[0]).toMatchObject({ t3ThreadId: testThreadId(10), attemptId: "attempt-1" });
  });

  it("a failed (ambiguous) launch records no association at all (F9)", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const result = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(result.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1); // the launch ran; it merely never settled
    const associations = await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect());
    const ledgers = await t.run(async (ctx) => await ctx.db.query("linearSyncLedger").collect());
    expect(associations).toHaveLength(0);
    expect(ledgers).toHaveLength(0);
  });

  it("a refused association recording is durably marked and visible in the operator queue; the launch outcome is unchanged (N6)", async () => {
    const t = await granted();
    await ready(t);
    // Launch issue-1: settles acknowledged on native thread 1 and records
    // exactly one association.
    const first = await authed(t).action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");

    // A second Linear issue launched through the SAME native thread (the
    // mock settles every launch on thread 1): the thread is already bound to
    // issue-1, so the association recording is REFUSED. The refusal is
    // deliberately swallowed by the launch path — but it is now durably
    // marked on the attempt row and surfaced by the operator queue.
    const second = await authed(t).action(api.t3Launch.launch, launchInput({
      attemptId: "attempt-2",
      linearIssueId: "issue-2",
      linearIssueIdentifier: "EGA-763",
    }));
    expect(second.outcome).toBe("launched"); // launch semantics untouched
    expect(second.threadId).toBe(first.threadId);

    const associations = await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect());
    expect(associations).toHaveLength(1); // still only issue-1's association

    // Drain the scheduler so the launch path's scheduled sync has run
    // DETERMINISTICALLY. Left to a real timer it could fire at any point
    // during the awaits below, which made this test's assertions depend on
    // timing rather than on behaviour.
    await t.finishAllScheduledFunctions(() => {});

    const queue = await authed(t).action(api.linearSync.openLedger, {});
    expect(queue.recordingFailures).toEqual([
      expect.objectContaining({
        attemptId: "attempt-2",
        issueKey: "issue-2",
        // The launch stored the authoritative Linear identifier.
        issueIdentifier: "EGA-681",
        attemptState: "acknowledged",
        note: "association recording failed (already_bound)",
      }),
    ]);
    // The refusal adds nothing to the ledger queue itself: the gap lives on
    // the attempt row, which has no ledger row of its own. The queue must
    // list the launch-derived row EXACTLY ONCE — the per-state reads are not
    // one atomic snapshot, so a row that moves buckets mid-read would
    // otherwise be reported twice under different states.
    expect(queue.open).toHaveLength(1);
    expect(queue.open[0]).toMatchObject({ linearIssueId: "issue-1" });
    // And it must not claim to be synced: this harness has no Linear endpoint
    // that can succeed. (The row's exact state legitimately depends on
    // whether the scheduled sync has run, so it is not pinned here.)
    expect(queue.open[0]!.state).not.toBe("synced");
  });
});
