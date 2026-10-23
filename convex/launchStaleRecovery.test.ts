/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";
import {
  LATEST_ATTEMPT_SCAN_LIMIT,
  pickLatestAttempt,
  sortAttemptsNewestFirst,
  type IssueAttemptRow,
} from "./lib/latestAttempt";

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
 * Cross-tab stale-recovery precondition: the two-tab sequence as a real test.
 *
 * Tab A and tab B both recover (no attempts) and hold `observedLatestAttemptId:
 * null`. Tab A launches and settles. Tab B then presses launch with its STALE
 * null token and a fresh attemptId: the reservation must refuse atomically
 * with the stale-recovery reason and dispatch no second launch. After tab B
 * re-recovers (fresh token), the same launch is ACCEPTED as an intentional
 * second execution.
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

describe("cross-tab stale recovery precondition", () => {
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

  async function attemptCount(t: Harness, issueKey: string): Promise<number> {
    const rows = await t.query(internal.launchAttempts.attemptsForIssue, { issueKey });
    return rows.length;
  }

  it("two tabs, one stale: B's launch with the stale null token is refused and dispatches no second launch", async () => {
    const t = await granted();
    await ready(t);

    // Tab A and tab B both recover before any attempt exists.
    const recoverA = await authed(t).action(api.t3Launch.recover, recoverInput());
    const recoverB = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(recoverA.observedLatestAttemptId).toBe(null);
    expect(recoverB.observedLatestAttemptId).toBe(null);
    expect(recoverA.outcome).toBe("none");
    expect(recoverB.outcome).toBe("none");

    // Tab A launches and settles.
    const first = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-A", expectedLatestAttemptId: recoverA.observedLatestAttemptId }),
    );
    expect(first.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(1);

    // Tab B presses launch with its STALE token and a fresh attemptId.
    await expect(
      authed(t).action(
        api.t3Launch.launch,
        launchInput({ attemptId: "attempt-B", expectedLatestAttemptId: recoverB.observedLatestAttemptId }),
      ),
    ).rejects.toThrow(/stale recovery/);
    // No second launch was dispatched and no second attempt was reserved.
    expect(launchCalls).toHaveLength(1);
    expect(await attemptCount(t, "issue-1")).toBe(1);
  });

  it("two tabs with a fresh token: after B re-recovers, B's launch is accepted as an intentional second execution", async () => {
    const t = await granted();
    await ready(t);

    const recoverA = await authed(t).action(api.t3Launch.recover, recoverInput());
    await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-A", expectedLatestAttemptId: recoverA.observedLatestAttemptId }),
    );
    expect(launchCalls).toHaveLength(1);

    // Stale attempt is refused …
    await expect(
      authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-B", expectedLatestAttemptId: null })),
    ).rejects.toThrow(/stale recovery/);
    expect(launchCalls).toHaveLength(1);

    // … but after a FRESH recovery the same launch is an intentional second
    // execution and is accepted.
    const freshB = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(freshB.observedLatestAttemptId).toBe("attempt-A");
    expect(freshB.outcome).toBe("acknowledged");
    expect(freshB.canStartNewExecution).toBe(true);
    const second = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-B", expectedLatestAttemptId: freshB.observedLatestAttemptId }),
    );
    expect(second.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(2);
    expect(await attemptCount(t, "issue-1")).toBe(2);
  });

  it("the no-attempts token path: null is accepted only while the issue genuinely has no attempts", async () => {
    const t = await granted();
    await ready(t);

    // Null is the correct token while there is nothing.
    const first = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-A" }));
    expect(first.outcome).toBe("launched");

    // The same null token is now stale and refused.
    await expect(
      authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-B", expectedLatestAttemptId: null })),
    ).rejects.toThrow(/stale recovery/);
    expect(launchCalls).toHaveLength(1);
    expect(await attemptCount(t, "issue-1")).toBe(1);
  });

  it("same-issue retry with the current token, same attemptId and same payload reuses the reservation", async () => {
    const t = await granted();
    await ready(t);

    const first = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-A" }));
    expect(first.outcome).toBe("launched");
    const fresh = await authed(t).action(api.t3Launch.recover, recoverInput());
    const retry = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-A", expectedLatestAttemptId: fresh.observedLatestAttemptId }),
    );
    expect(retry.outcome).toBe("launched");
    expect(retry.threadId).toBe(first.threadId);
    expect(launchCalls).toHaveLength(1);
    expect(await attemptCount(t, "issue-1")).toBe(1);
  });

  it("a different payload with the same attemptId is still refused", async () => {
    const t = await granted();
    await ready(t);

    const first = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-A" }));
    expect(first.outcome).toBe("launched");
    await expect(
      authed(t).action(
        api.t3Launch.launch,
        launchInput({ attemptId: "attempt-A", prompt: "a different launch" }),
      ),
    ).rejects.toThrow(/does not match its reservation/);
    expect(launchCalls).toHaveLength(1);
    expect(await attemptCount(t, "issue-1")).toBe(1);
  });

  it("two different issues are unaffected by each other's tokens", async () => {
    const t = await granted();
    await ready(t);

    // A launch on issue-1 settles it; issue-2 still has no history.
    await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-A" }));
    const otherRecovery = await authed(t).action(api.t3Launch.recover, recoverInput({ linearIssueId: "issue-2" }));
    expect(otherRecovery.observedLatestAttemptId).toBe(null);

    // A stale-for-issue-1 null token is still the CURRENT token for issue-2.
    const second = await authed(t).action(
      api.t3Launch.launch,
      launchInput({
        attemptId: "attempt-other",
        linearIssueId: "issue-2",
        linearIssueIdentifier: "EGA-682",
        expectedLatestAttemptId: otherRecovery.observedLatestAttemptId,
      }),
    );
    expect(second.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(2);
    expect(await attemptCount(t, "issue-1")).toBe(1);
    expect(await attemptCount(t, "issue-2")).toBe(1);

    // And a token from issue-2 is stale on issue-1.
    await expect(
      authed(t).action(
        api.t3Launch.launch,
        launchInput({ attemptId: "attempt-C", expectedLatestAttemptId: otherRecovery.observedLatestAttemptId }),
      ),
    ).rejects.toThrow(/stale recovery/);
    expect(launchCalls).toHaveLength(2);
  });

  it("ambiguous still blocks with a fresh token and never relaunches", async () => {
    const t = await granted();
    await ready(t);
    ackThreadId = null;
    listMatches = 0;

    const first = await authed(t).action(api.t3Launch.launch, launchInput({ attemptId: "attempt-A" }));
    expect(first.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);

    // The tab re-recovers: the token is the now-current ambiguous attempt.
    const fresh = await authed(t).action(api.t3Launch.recover, recoverInput());
    expect(fresh.observedLatestAttemptId).toBe("attempt-A");
    expect(fresh.outcome).toBe("ambiguous");

    // A new execution behind an ambiguous attempt is refused by the
    // unresolved lock — no relaunch, no new reservation.
    const refused = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-B", expectedLatestAttemptId: fresh.observedLatestAttemptId }),
    );
    expect(refused.outcome).toBe("in_progress");
    expect(launchCalls).toHaveLength(1);
    expect(await attemptCount(t, "issue-1")).toBe(1);

    // A retry of the same ambiguous reservation still refuses to relaunch.
    const retry = await authed(t).action(
      api.t3Launch.launch,
      launchInput({ attemptId: "attempt-A", expectedLatestAttemptId: fresh.observedLatestAttemptId }),
    );
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });
});

describe("latest-attempt helper units", () => {
  function row(attemptId: string, creationTime: number, idSuffix: string): IssueAttemptRow {
    return {
      _id: `launchAttempts|${idSuffix}` as IssueAttemptRow["_id"],
      _creationTime: creationTime,
      attemptId,
      issueKey: "issue-1",
      correlationKey: `[helm:issue-1:${attemptId}]`,
      state: "acknowledged",
      threadId: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      matchCount: null,
    };
  }

  it("returns null when there are no attempts", () => {
    expect(pickLatestAttempt([])).toBe(null);
  });

  it("returns the single row when there is one attempt", () => {
    const only = row("attempt-1", 1000, "aaa");
    expect(pickLatestAttempt([only])).toBe(only);
  });

  it("picks the newest by _creationTime across many rows regardless of input order", () => {
    const oldest = row("attempt-old", 1000, "aaa");
    const middle = row("attempt-mid", 2000, "aab");
    const newest = row("attempt-new", 3000, "aac");
    expect(pickLatestAttempt([newest, oldest, middle])).toBe(newest);
    expect(pickLatestAttempt([oldest, middle, newest])).toBe(newest);
    expect(pickLatestAttempt([middle, newest, oldest])).toBe(newest);
  });

  it("breaks _creationTime ties deterministically on _id order", () => {
    const first = row("attempt-1", 1000, "aaa");
    const second = row("attempt-2", 1000, "aab");
    expect(pickLatestAttempt([first, second])).toBe(second);
    expect(pickLatestAttempt([second, first])).toBe(second);
    expect(sortAttemptsNewestFirst([first, second]).map((r) => r.attemptId)).toEqual([
      "attempt-2",
      "attempt-1",
    ]);
  });

  it("sorts newest-first over many rows", () => {
    const a = row("a", 100, "a01");
    const b = row("b", 300, "a02");
    const c = row("c", 200, "a03");
    expect(sortAttemptsNewestFirst([a, b, c]).map((r) => r.attemptId)).toEqual(["b", "c", "a"]);
  });

  it("documents its scan bound", () => {
    expect(LATEST_ATTEMPT_SCAN_LIMIT).toBeGreaterThanOrEqual(100);
  });

  it("attemptsForIssue newest-first agrees with the shared latest helper", async () => {
    const t = convexTest(schema, modules);
    const PAYLOAD = "f".repeat(64);
    for (let i = 0; i < 3; i++) {
      const attemptId = `helper-agree-${i}`;
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "issue-agree",
        attemptId,
        payloadHash: PAYLOAD,
      });
      await t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId,
        threadId: testThreadId(300 + i),
        at: 1_700_000_000_000 + i,
      });
    }
    const rows = await t.query(internal.launchAttempts.attemptsForIssue, { issueKey: "issue-agree" });
    expect(rows.map((r) => r.attemptId)).toEqual(["helper-agree-2", "helper-agree-1", "helper-agree-0"]);
  });
});
