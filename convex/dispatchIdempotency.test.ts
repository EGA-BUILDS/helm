/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * M-2: durable launch idempotency, end to end.
 *
 * Every test here drives the REAL dispatchIssue action against the REAL
 * Convex functions (through convex-test), with only the MCP client mocked. The
 * mock counts `t3_thread_launch` invocations, so a duplicate dispatch is
 * directly observable as a second launch call. No real network access.
 */

const mcp = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(...args: unknown[]) { return mcp.connect(...args); }
    callTool(...args: unknown[]) { return mcp.callTool(...args); }
    close(...args: unknown[]) { return mcp.close(...args); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ISOLATED_ENDPOINT = "https://isolated.example.invalid/mcp";
const ISOLATED_TOKEN = "test-token-placeholder";
const PROVIDER = "t3-mcp";
const ISSUE = "EGA-677";
const PROJECT = "mcp:project";
const MESSAGE = "test message";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const modules = import.meta.glob("./**/*.ts");

/** One callTool request as the SDK issues it: a single `{ name, arguments }` object. */
type ToolRequest = { name?: string; arguments?: Record<string, unknown> };

/** Arguments of one t3_thread_launch invocation. */
function launchCalls(): Array<Record<string, unknown>> {
  return mcp.callTool.mock.calls
    .map(([req]) => req as ToolRequest)
    .filter((req) => req?.name === "t3_thread_launch")
    .map((req) => req.arguments ?? {});
}

/** Count t3_thread_list (reconciliation search) invocations. */
function searchCalls(): number {
  return mcp.callTool.mock.calls.filter(
    ([req]) => (req as ToolRequest)?.name === "t3_thread_list",
  ).length;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Make the mocked launch tool return an acknowledged thread id. */
function launchAcknowledges(threadId: string) {
  mcp.connect.mockResolvedValue(undefined);
  mcp.close.mockResolvedValue(undefined);
  mcp.callTool.mockImplementation(async (req: ToolRequest) => {
    if (req?.name === "t3_thread_launch") {
      return { content: [{ text: JSON.stringify({ threadId }) }] };
    }
    return { content: [{ text: JSON.stringify({ threads: [] }) }] };
  });
}

/**
 * The canonical payload hash dispatchIssue computes for these fixtures.
 * Mirrors `canonicalPayloadHash` in convex/dispatch.ts so tests can seed
 * attempt rows the action itself will recognize as its own reservation.
 */
async function canonicalHash(overrides: Record<string, unknown> = {}): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(
      JSON.stringify([
        (overrides.provider as string) ?? PROVIDER,
        (overrides.issueKey as string) ?? ISSUE,
        (overrides.projectId as string) ?? PROJECT,
        (overrides.message as string) ?? MESSAGE,
        (overrides.runtimeMode as string) ?? "approval-required",
      ]),
    )
    .digest("hex");
}

async function seed(t: ReturnType<typeof convexTest>) {
  const grant = await t.mutation(internal.auth.grantOwner, {
    subject: OWNER_SUBJECT,
    issuer: OWNER_ISSUER,
  });
  await t.mutation(internal.credentials.recordCredential, {
    provider: PROVIDER,
    scopes: ["orchestration:read", "orchestration:operate"],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
  return (overrides: Record<string, unknown> = {}) => ({
    ownerGrant: { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision },
    requestId: `${ISSUE}:req-1`,
    provider: PROVIDER,
    issueKey: ISSUE,
    projectId: PROJECT,
    message: MESSAGE,
    runtimeMode: "approval-required",
    ...overrides,
  });
}

/** Save/restore the four environment variables every test here manipulates. */
const ENV_KEYS = [
  "HELM_OWNER_SUBJECT",
  "CLERK_FRONTEND_API_URL",
  "T3_MCP_URL_ISOLATED",
  "T3_MCP_TOKEN_ISOLATED",
  "T3_PROJECT_ID_ISOLATED",
] as const;
let savedEnv: Record<string, string | undefined> = {};

function configureEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
  process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  process.env.T3_MCP_URL_ISOLATED = ISOLATED_ENDPOINT;
  process.env.T3_MCP_TOKEN_ISOLATED = ISOLATED_TOKEN;
  process.env.T3_PROJECT_ID_ISOLATED = PROJECT;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const attemptsIn = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());

describe("M-2: durable launch idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEnv();
  });

  afterEach(restoreEnv);

  it.each([
    ["wrong project", { projectId: "other-project" }],
    ["wrong provider", { provider: "another-provider" }],
    ["unsupported runtime mode", { runtimeMode: "full-access" }],
  ])("blocks %s before the remote launch", async (_label, overrides) => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(2));
    const result = await t.action(internal.dispatch.dispatchIssue, args(overrides));
    expect(result.outcome).toBe("blocked");
    expect(launchCalls()).toHaveLength(0);
    expect(await attemptsIn(t)).toHaveLength(0);
  });

  it("blocks dispatch when the trusted project mapping is absent", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    delete process.env.T3_PROJECT_ID_ISOLATED;
    launchAcknowledges(testThreadId(2));
    const result = await t.action(internal.dispatch.dispatchIssue, args());
    expect(result.outcome).toBe("blocked");
    expect(launchCalls()).toHaveLength(0);
    expect(await attemptsIn(t)).toHaveLength(0);
  });

  it("recovers a durable unresolved reservation and blocks a new request after restart", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    const oldRequestId = `${ISSUE}:before-restart`;
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      targetProjectId: PROJECT,
      attemptId: oldRequestId,
      payloadHash: await canonicalHash(),
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: oldRequestId, at: Date.now() });

    // A fresh action invocation has no in-memory knowledge of the earlier
    // process; the durable attempt table still blocks it before transport use.
    launchAcknowledges(testThreadId(3));
    await expect(t.action(internal.dispatch.dispatchIssue, args({ requestId: `${ISSUE}:after-restart` })))
      .rejects.toThrow(/unresolved attempt/);
    expect(launchCalls()).toHaveLength(0);
    expect(await attemptsIn(t)).toHaveLength(1);
  });

  it("rejects a same-ID payload conflict without a second remote launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(4));
    await t.action(internal.dispatch.dispatchIssue, args());
    await expect(t.action(internal.dispatch.dispatchIssue, args({ message: "changed payload" })))
      .rejects.toThrow(/different payload/);
    expect(launchCalls()).toHaveLength(1);
  });

  it("duplicate request AFTER acknowledgement returns the known result, no second launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(5));

    const first = await t.action(internal.dispatch.dispatchIssue, args());
    expect(first.outcome).toBe("dispatched");
    expect(first.threadId).toBe(testThreadId(5));

    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("dispatched");
    expect(retry.threadId).toBe(testThreadId(5));
    expect(retry.detail).toContain("without a remote call");
    // The durable row answered the retry; T3 was reached exactly once.
    expect(launchCalls()).toHaveLength(1);
    // One attempt row, acknowledged under the caller's request id.
    const rows = await attemptsIn(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("acknowledged");
    expect(rows[0]?.attemptId).toBe(`${ISSUE}:req-1`);
  });

  it("concurrent same-ID actions issue exactly one remote launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(6));
    const results = await Promise.all([
      t.action(internal.dispatch.dispatchIssue, args()),
      t.action(internal.dispatch.dispatchIssue, args()),
    ]);
    expect(results.map((result) => result.outcome).every((outcome) =>
      outcome === "dispatched" || outcome === "in_progress",
    )).toBe(true);
    expect(launchCalls()).toHaveLength(1);
    expect(await attemptsIn(t)).toHaveLength(1);
  });

  it("a same-ID retry arriving during a gated remote launch cannot launch twice", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    const started = deferred();
    const gate = deferred();
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockImplementation(async (req: ToolRequest) => {
      if (req?.name === "t3_thread_launch") {
        started.resolve();
        await gate.promise;
        return { content: [{ text: JSON.stringify({ threadId: testThreadId(30) }) }] };
      }
      return { content: [{ text: JSON.stringify({ threads: [] }) }] };
    });

    const first = t.action(internal.dispatch.dispatchIssue, args());
    await started.promise;
    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("in_progress");
    expect(launchCalls()).toHaveLength(1);
    gate.resolve();
    expect((await first).outcome).toBe("dispatched");
    expect(launchCalls()).toHaveLength(1);
  });

  it("concurrent different IDs for one issue produce at most one remote launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(7));
    const results = await Promise.allSettled([
      t.action(internal.dispatch.dispatchIssue, args()),
      t.action(internal.dispatch.dispatchIssue, args({ requestId: `${ISSUE}:req-2` })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(launchCalls()).toHaveLength(1);
    expect(await attemptsIn(t)).toHaveLength(1);
  });

  it("a different ID arriving during a gated launch is rejected before another launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    const started = deferred();
    const gate = deferred();
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockImplementation(async (req: ToolRequest) => {
      if (req?.name === "t3_thread_launch") {
        started.resolve();
        await gate.promise;
        return { content: [{ text: JSON.stringify({ threadId: testThreadId(31) }) }] };
      }
      return { content: [{ text: JSON.stringify({ threads: [] }) }] };
    });

    const first = t.action(internal.dispatch.dispatchIssue, args());
    await started.promise;
    const competing = t.action(
      internal.dispatch.dispatchIssue,
      args({ requestId: `${ISSUE}:competing` }),
    );
    await expect(competing).rejects.toThrow(/unresolved attempt/);
    expect(launchCalls()).toHaveLength(1);
    gate.resolve();
    expect((await first).outcome).toBe("dispatched");
    expect(launchCalls()).toHaveLength(1);
  });

  it("duplicate request DURING dispatch issues no second launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    // Seed the exact mid-dispatch state under the action's own canonical hash,
    // as if the original invocation had reserved and was connecting right now.
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      targetProjectId: PROJECT,
      attemptId: `${ISSUE}:req-1`,
      payloadHash: await canonicalHash(),
    });
    await t.mutation(internal.launchAttempts.markDispatching, {
      attemptId: `${ISSUE}:req-1`,
      at: Date.now(),
    });

    launchAcknowledges(testThreadId(8));
    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("in_progress");
    expect(retry.relaunchAuthorized).toBe(false);
    // The outcome is unknown; a second launch is exactly what must not happen.
    expect(launchCalls()).toHaveLength(0);
  });

  it("retry after a LOST acknowledgment reconciles and never relaunches", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    // The launch succeeds but its receipt is discarded (forceLostAck); the
    // search then finds exactly the one thread the launch titled.
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockImplementation(async (req: ToolRequest) => {
      if (req?.name === "t3_thread_launch") {
        return { content: [{ text: JSON.stringify({ threadId: testThreadId(9) }) }] };
      }
      // Echo the launch's title (which carries the correlation key) back as
      // the single listed thread: the reconciliation match.
      const launch = launchCalls()[0];
      const title = String(launch?.title ?? "");
      return {
        content: [{ text: JSON.stringify({ threads: [{ threadId: testThreadId(10), title }] }) }],
      };
    });

    const first = await t.action(internal.dispatch.dispatchIssue, { ...args(), forceLostAck: true });
    expect(first.outcome).toBe("reconciled");
    expect(first.threadId).toBe(testThreadId(10));
    expect(launchCalls()).toHaveLength(1);

    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("dispatched");
    expect(retry.threadId).toBe(testThreadId(10));
    expect(retry.detail).toContain("without a remote call");
    expect(launchCalls()).toHaveLength(1); // still exactly one remote launch
  });

  it("lost ack with zero reconciliation matches stays unresolved through retry", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockImplementation(async (req: ToolRequest) => {
      if (req?.name === "t3_thread_launch") {
        return { content: [{ text: JSON.stringify({ threadId: testThreadId(32) }) }] };
      }
      return { content: [{ text: JSON.stringify({ threads: [] }) }] };
    });

    const first = await t.action(internal.dispatch.dispatchIssue, {
      ...args(),
      forceLostAck: true,
    });
    expect(first.outcome).toBe("ambiguous");
    expect(first.relaunchAuthorized).toBe(false);
    expect(launchCalls()).toHaveLength(1);
    expect(searchCalls()).toBe(1);

    const callsBeforeRetry = mcp.callTool.mock.calls.length;
    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(mcp.callTool.mock.calls).toHaveLength(callsBeforeRetry);
    expect(launchCalls()).toHaveLength(1);
    expect(await attemptsIn(t)).toMatchObject([{ state: "ambiguous", threadId: null }]);
  });

  it("the SAME request id with a CHANGED payload is rejected", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(11));
    const first = await t.action(internal.dispatch.dispatchIssue, args());
    expect(first.outcome).toBe("dispatched");

    await expect(
      t.action(internal.dispatch.dispatchIssue, args({ message: "DIFFERENT message" })),
    ).rejects.toThrow(/different payload/);
    expect(launchCalls()).toHaveLength(1);
  });

  it("DIFFERENT request ids cannot race past an unresolved attempt", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    // First invocation ends ambiguous: the endpoint is unreachable.
    mcp.connect.mockImplementation(async () => {
      throw new Error("DISPATCH_TEST_CONNECT_TIMEOUT");
    });
    mcp.close.mockResolvedValue(undefined);
    const first = await t.action(internal.dispatch.dispatchIssue, args());
    expect(first.outcome).toBe("ambiguous");

    // A competing NEW request id for the same issue is refused outright.
    await expect(
      t.action(internal.dispatch.dispatchIssue, args({ requestId: `${ISSUE}:req-2` })),
    ).rejects.toThrow(/unresolved attempt/);
    expect(launchCalls()).toHaveLength(0);
  });

  it("two OVERLAPPING identical requests produce exactly one launch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(12));

    const results = await Promise.allSettled([
      t.action(internal.dispatch.dispatchIssue, args()),
      t.action(internal.dispatch.dispatchIssue, args()),
    ]);
    const fulfilled = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof t.action>>> => r.status === "fulfilled")
      .map((r) => r.value);
    // Whichever interleaving runs: exactly one remote launch, one attempt row,
    // and at least one invocation reports the dispatched result. The loser may
    // fulfil with a reuse outcome or be refused at the state transition; it
    // must never dispatch.
    expect(launchCalls()).toHaveLength(1);
    expect(fulfilled.some((r) => (r as { outcome: string }).outcome === "dispatched")).toBe(true);
    const rows = await attemptsIn(t);
    expect(rows).toHaveLength(1);
  });

  it("a STALE owner-grant revision is refused before any launch or attempt", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    launchAcknowledges(testThreadId(13));
    await expect(t.action(internal.dispatch.dispatchIssue, args())).rejects.toThrow(/unauthorized/i);
    expect(launchCalls()).toHaveLength(0);
    expect(await attemptsIn(t)).toHaveLength(0);
  });

  it("retry after an AMBIGUOUS outcome never re-dispatches", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    mcp.connect.mockImplementation(async () => {
      throw new Error("DISPATCH_TEST_CONNECT_REFUSED");
    });
    mcp.close.mockResolvedValue(undefined);
    const first = await t.action(internal.dispatch.dispatchIssue, args());
    expect(first.outcome).toBe("ambiguous");

    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.detail).toContain("reconcileAttempt");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls()).toHaveLength(0);
  });

  it("a retry cannot produce a SECOND recorded network launch, on any path", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    // Auth failure on the first invocation pauses the credential.
    mcp.connect.mockImplementation(async () => {
      throw new Error("401 invalid_mcp_credential");
    });
    mcp.close.mockResolvedValue(undefined);
    const first = await t.action(internal.dispatch.dispatchIssue, args());
    expect(first.outcome).toBe("ambiguous");
    expect(launchCalls()).toHaveLength(0);

    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    // The credential was paused by the first invocation's auth failure, so the
    // retry is stopped by the credential gate BEFORE the reservation: never
    // retried into a wall, never re-dispatched.
    expect(retry.outcome).toBe("paused");
    expect(retry.detail).toContain("reauthorization");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls()).toHaveLength(0);
  });

  it("an ABANDONED request id requires a NEW id for an explicit relaunch", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      targetProjectId: PROJECT,
      attemptId: `${ISSUE}:req-1`,
      payloadHash: await canonicalHash(),
    });
    await t.mutation(internal.launchAttempts.abandonAttempt, {
      attemptId: `${ISSUE}:req-1`,
      note: "operator abandoned",
    });
    const retry = await t.action(internal.dispatch.dispatchIssue, args());
    expect(retry.outcome).toBe("blocked");
    expect(retry.detail).toContain("new request id");
    expect(launchCalls()).toHaveLength(0);
  });

  it("provider/target binding: a non-T3 provider is refused before any state change", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(14));
    const res = await t.action(internal.dispatch.dispatchIssue, args({ provider: "opencode_2" }));
    expect(res.outcome).toBe("blocked");
    expect(res.detail).toContain("not bound");
    expect(launchCalls()).toHaveLength(0);
    expect(await attemptsIn(t)).toHaveLength(0);
  });

  it("L-1: NO MCP initialization occurs when the grant is revoked", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    launchAcknowledges(testThreadId(15));
    await expect(t.action(internal.dispatch.dispatchIssue, args())).rejects.toThrow(/unauthorized/i);
    // Not merely "no launch": no transport was ever constructed or connected,
    // so the bearer token was never transmitted.
    expect(mcp.connect).not.toHaveBeenCalled();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it("L-1: no MCP initialization when the grant became stale mid-queue", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(t.action(internal.dispatch.dispatchIssue, args())).rejects.toThrow(/unauthorized/i);
    expect(mcp.connect).not.toHaveBeenCalled();
  });

  it("the launch title carries the correlation key (the reconciliation handle)", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    launchAcknowledges(testThreadId(16));
    await t.action(internal.dispatch.dispatchIssue, args());
    const title = String(launchCalls()[0]?.title ?? "");
    expect(title).toContain("Helm dispatch");
    expect(title).toMatch(/\[helm:EGA-677:[a-z2-9]+\]/);
    expect(searchCalls()).toBe(0); // a clean ack never needs to search
  });
});

describe("reconciliation never regresses and never relaunches (L-3, action-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEnv();
  });

  afterEach(restoreEnv);

  it("rejects a malformed remote thread ID and keeps the attempt ambiguous", async () => {
    const t = convexTest(schema, modules);
    const args = await seed(t);
    const attemptId = `${ISSUE}:malformed-reconcile`;
    const prepared = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      targetProjectId: PROJECT,
      attemptId,
      payloadHash: "e".repeat(64),
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId, at: Date.now() });
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockResolvedValue({
      content: [{
        text: JSON.stringify({
          threads: [{ threadId: "malformed thread id", title: prepared.correlationKey }],
        }),
      }],
    });
    const result = await t.action(internal.dispatch.reconcileAttempt, {
      attemptId,
      projectId: PROJECT,
      ownerGrant: args().ownerGrant,
    });
    expect(result.state).toBe("ambiguous");
    expect(result.threadId).toBe(null);
    expect(result.relaunchAuthorized).toBe(false);
    expect(await attemptsIn(t)).toMatchObject([{ state: "ambiguous", threadId: null }]);
  });

  it("a settled attempt stays settled through repeated reconcileAttempt calls", async () => {
    const t = convexTest(schema, modules);
    const grant = await t.mutation(internal.auth.grantOwner, {
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    const attemptId = `${ISSUE}:req-9`;
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      targetProjectId: PROJECT,
      attemptId,
      payloadHash: "9".repeat(64),
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId, at: Date.now() });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId,
      threadId: testThreadId(17),
      at: Date.now(),
    });

    // The search now finds NOTHING (stale listing). The settled result must
    // survive every repeated reconciliation.
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.callTool.mockImplementation(async () => ({
      content: [{ text: JSON.stringify({ threads: [] }) }],
    }));

    for (let i = 0; i < 3; i++) {
      const v = await t.action(internal.dispatch.reconcileAttempt, {
        attemptId,
        projectId: PROJECT,
        ownerGrant: { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision },
      });
      expect(v.state).toBe("acknowledged");
      expect(v.threadId).toBe(testThreadId(17));
      expect(v.relaunchAuthorized).toBe(false);
    }
    expect(launchCalls()).toHaveLength(0);
    const row = await t.query(internal.launchAttempts.getCorrelationForReconciliation, { attemptId });
    expect(row?.state).toBe("acknowledged");
    expect(row?.threadId).toBe(testThreadId(17));
  });
});
