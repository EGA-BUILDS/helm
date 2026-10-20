/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { operateToolCall } from "./t3OAuth";
import { SEND_REQUEST_INVALID, SEND_THREAD_MISMATCH } from "./lib/sendErrors";

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
 * Native follow-up send contract (EGA-764 D10).
 *
 * There is NO live T3 connection here, so the send path's live behaviour is
 * NOT tested: every remote call is served by the mocked MCP client above.
 * What IS proven: the permission boundary (read-only can never reach the
 * write tool, before any network call), the server-side identity binding
 * (thread/project mismatch never sends), the envelope derivation (accepted /
 * queued / rejected / ambiguous are distinct), the queue mode, and honest
 * replay reporting.
 *
 * The mocked native server below mirrors the CONFIRMED native contract and
 * nothing else: `t3_thread_send` answers with exactly `threadId`, `messageId`,
 * `runId`, `status` and `delivery` (`doc/v0.2/evidence/ega-758-probe-receipts.json`:
 * "follow-up — keys=threadId,messageId,runId,status,delivery"). It NEVER
 * answers with a duplicate marker, because the native contract has none: the
 * confirmed replay returned the SAME `messageId`, `runId`, `status` and
 * `delivery` as the first send, and the dedupe evidence was the thread
 * activity item count (8 -> 9 -> 9), not a response field.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };
const ENDPOINT = "https://operate.example.invalid/mcp";
const ENV_ID = "env-op";
const T3_PROJECT = "t3-proj-1";
const OTHER_PROJECT = "t3-proj-other";
/** A request id long enough to be distinctive (see the backend's rule). */
const DISTINCTIVE_KEY = "req-00000000-0000-4000-8000-000000000001";

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

/** The native thread's activity items, in the order the native returns them. */
function threadFixture(
  threadId: string,
  projectId: string,
  itemIds: readonly string[],
  runIds: readonly string[] = [],
) {
  const items = itemIds.map((item, index) => ({
    itemId: item,
    position: index + 1,
    type: "user_message",
    text: "follow up",
    updatedAt: "2026-10-18T16:31:44.000Z",
    textTruncated: false,
    itemTextOffset: null,
  }));
  const recentRuns = runIds.map((runId, index) => ({
    runId,
    ordinal: index + 1,
    status: "starting",
    providerInstanceId: "opencode_2",
    model: "opencode-go/deepseek-v4.1-flash",
    requestedAt: "2026-10-18T16:31:44.000Z",
    startedAt: "2026-10-18T16:31:44.000Z",
    completedAt: null,
  }));
  return {
    thread: { threadId, projectId, title: "Follow-up target" },
    items,
    recentRuns,
    nextPosition: null,
    hasMore: false,
  };
}

function sendInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: undefined as unknown as Id<"t3Connections">,
    projectId: T3_PROJECT,
    threadId: testThreadId(1),
    message: "follow up: confirm the plan",
    clientRequestId: "req-1",
    ...overrides,
  };
}

describe("t3Send: native follow-up prompt", () => {
  let savedKeys: Record<string, string | undefined>;
  let sendCalls: { name: string; args: Record<string, unknown> }[];
  let toolNames: string[];
  /** threadId -> projectId for the mocked native thread read. */
  let threadProjects: Map<string, string>;
  /** threadId -> the native activity item ids that exist in that thread. */
  let threadItems: Map<string, string[]>;
  /** threadId -> the native run ids that exist in that thread. */
  let threadRuns: Map<string, string[]>;
  /** clientRequestId -> the native envelope: the mocked idempotency registry. */
  let replayRegistry: Map<string, { messageId: string; runId: string }>;
  let createdMessages: { threadId: string; messageId: string }[];
  let messageCounter: number;
  /** Controls the mocked native send acknowledgement. */
  let sendBehaviour: "queued" | "accepted" | "rejected" | "unclear-shape";
  let sendTransportError: string | null;
  /** Makes the thread read fail once a send has been issued. */
  let failPostSendRead: boolean;
  /**
   * A queued message may not appear in the thread timeline yet. When this is
   * false the native message is visible only through its run.
   */
  let materializeMessageItems: boolean;
  let sendIssued: boolean;

  beforeEach(() => {
    savedKeys = {
      T3_OAUTH_ENCRYPTION_KEY_VERSION: process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION,
      T3_OAUTH_ENCRYPTION_KEY_V1: process.env.T3_OAUTH_ENCRYPTION_KEY_V1,
      T3_OAUTH_ENCRYPTION_KEY: process.env.T3_OAUTH_ENCRYPTION_KEY,
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;

    sendCalls = [];
    toolNames = [];
    threadProjects = new Map([[testThreadId(1), T3_PROJECT]]);
    threadItems = new Map();
    threadRuns = new Map();
    replayRegistry = new Map();
    createdMessages = [];
    messageCounter = 0;
    sendBehaviour = "queued";
    sendTransportError = null;
    failPostSendRead = false;
    materializeMessageItems = true;
    sendIssued = false;
    mock.connect.mockReset().mockResolvedValue(undefined);
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.listTools.mockReset();
    mock.callTool.mockReset().mockImplementation(baseCallTool);
  });

  type McpCall = { name: string; arguments: Record<string, unknown> };

  /** Default MCP behaviour: every remote call succeeds off the closure fixtures. */
  async function baseCallTool(call: McpCall) {
    toolNames.push(call.name);
    if (call.name === "t3_environment_read") return textResult(envFixture());
    if (call.name === "t3_thread_read") {
      if (failPostSendRead && sendIssued) throw new Error("T3 request failed (503)");
      const threadId = String(call.arguments.threadId ?? "");
      const projectId = threadProjects.get(threadId);
      if (!projectId) throw new Error("T3 request failed (404)");
      return textResult(
        threadFixture(
          threadId,
          projectId,
          threadItems.get(threadId) ?? [],
          threadRuns.get(threadId) ?? [],
        ),
      );
    }
    if (call.name === "t3_thread_send") {
      sendCalls.push({ name: call.name, args: call.arguments });
      if (sendTransportError) throw new Error(sendTransportError);
      sendIssued = true;
      const threadId = String(call.arguments.threadId ?? "");
      const clientRequestId = String(call.arguments.clientRequestId ?? "");
      if (sendBehaviour === "rejected") {
        return textResult({ threadId, status: "rejected", delivery: "rejected" });
      }
      if (sendBehaviour === "unclear-shape") {
        return textResult({ threadId, status: "something-unrecognized", delivery: "something-unrecognized" });
      }
      // The CONFIRMED native contract: a replayed clientRequestId answers with
      // the SAME envelope and creates NO second activity item (the confirmed
      // probe saw the item count stay at 9 on the replay). There is no
      // duplicate marker in the response, and none is invented here.
      const replayed = replayRegistry.get(clientRequestId);
      if (replayed) {
        return textResult({
          threadId,
          messageId: replayed.messageId,
          runId: replayed.runId,
          status: sendBehaviour === "queued" ? "queued" : "accepted",
          delivery: sendBehaviour === "queued" ? "queued" : "delivered",
        });
      }
      messageCounter += 1;
      const messageId = `message:mcp:client%3Ahelm-test-client:thread-send:${clientRequestId}`;
      const runId = `run:thread:${threadId}:ordinal:${messageCounter}`;
      replayRegistry.set(clientRequestId, { messageId, runId });
      createdMessages.push({ threadId, messageId });
      // The native message becomes exactly one thread activity item, and the
      // request always leaves exactly one run behind.
      const runs = threadRuns.get(threadId) ?? [];
      runs.push(runId);
      threadRuns.set(threadId, runs);
      if (materializeMessageItems) {
        const items = threadItems.get(threadId) ?? [];
        items.push(messageId);
        threadItems.set(threadId, items);
      }
      return textResult({
        threadId,
        messageId,
        runId,
        status: sendBehaviour === "queued" ? "queued" : "accepted",
        delivery: sendBehaviour === "queued" ? "queued" : "delivered",
      });
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

  function authed(t: Harness) {
    return t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  }

  it("a read-only connection can never reach the write tool, before any network call", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: readonlyId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/operate access has not been granted/);
    expect(result.messageId).toBe(null);
    expect(result.dedupe).toBe("unverified");
    expect(sendCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("a missing operate grant refuses with the specific reason", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: readonlyId }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "authorization_required" });
    expect(sendCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("an ambiguous operate inventory refuses rather than picking one", async () => {
    const t = await granted();
    const first = await seedConnection(t, { access: "operate" });
    await seedConnection(t, { access: "operate" });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: first }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toMatch(/ambiguous/);
    expect(sendCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", "expired", /expired/],
    ["reauthorizationRequired", "authorization_required", /revoked/],
    ["unreachable", "unreachable", /unreachable/],
  ] as const)("a %s operate connection refuses with %s", async (status, reason, detail) => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate", status });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe(reason);
    expect(result.detail).toMatch(detail);
    expect(sendCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("a caller connection that is not the operate grant refuses without sending", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    await seedConnection(t, { access: "operate" });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: readonlyId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("rejected");
    expect(result.detail).toMatch(/not the authorized operate connection/);
    expect(sendCalls).toHaveLength(0);
  });

  it("denies anonymous, non-owner, and revoked callers", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.t3Send.send, sendInput({ connectionId: operateId }))).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.t3Send.send, sendInput({ connectionId: operateId }))).rejects.toThrow(/unauthorized/);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }))).rejects.toThrow(/unauthorized/);
    expect(sendCalls).toHaveLength(0);
  });

  it("a stale grant revision cannot send", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(sendCalls).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("a thread that belongs to another project never receives the message", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const foreignThread = testThreadId(2);
    threadProjects.set(foreignThread, OTHER_PROJECT);
    await expect(
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, threadId: foreignThread, projectId: T3_PROJECT })),
    ).rejects.toThrow(SEND_THREAD_MISMATCH);
    expect(sendCalls).toHaveLength(0);
    expect(toolNames).not.toContain("t3_thread_send");
    expect(toolNames).toContain("t3_thread_read");
  });

  it("a thread id the native read does not recognize refuses as a mismatch", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    // The mocked native read throws 404 for unknown threads; the read path
    // surfaces it and the send path maps it to not_found without sending.
    const result = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, threadId: testThreadId(99) }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("not_found");
    expect(sendCalls).toHaveLength(0);
  });

  it("rejects an empty message as an invalid request before any network call", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    await expect(
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, message: "" })),
    ).rejects.toThrow(SEND_REQUEST_INVALID);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("reports the confirmed native receipt shape (a queued status with a message id) as queued", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    // The confirmed receipt is `status: "queued", delivery: "queued"` WITH a
    // message id and a run id: that is a queued message, never an executed
    // one, and never silently relabelled "accepted".
    expect(result.outcome).toBe("queued");
    expect(result.reason).toBe(null);
    expect(result.threadId).toBe(testThreadId(1));
    expect(result.messageId).toBe("message:mcp:client%3Ahelm-test-client:thread-send:req-1");
    expect(result.runId).toBe(`run:thread:${testThreadId(1)}:ordinal:1`);
    expect(result.clientRequestId).toBe("req-1");
    expect(result.dedupe).toBe("not_duplicate_observed");
    expect(result.detail).toMatch(/queued.*has not run yet/);
    expect(result.detail).not.toMatch(/execut|complet|ran|finished/i);
    expect(sendCalls).toHaveLength(1);
  });

  it("sends the queue mode verbatim and never substitutes another mode", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(sendCalls).toHaveLength(1);
    // This is the guarantee: the arguments that actually reach the native
    // tool. It holds whatever the source computes the mode from, so it is not
    // a grep for a literal.
    expect(sendCalls[0]!.args).toMatchObject({
      threadId: testThreadId(1),
      message: "follow up: confirm the plan",
      clientRequestId: "req-1",
      mode: "queue",
    });
    // The native contract allows auto/queue/steer/restart. `queue` is the
    // only one this path may use: steer and restart change the running turn
    // and auto lets the native server choose.
    for (const call of sendCalls) expect(call.args.mode).toBe("queue");
  });

  it("an accepted acknowledgement is reported as accepted and never claims execution", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    sendBehaviour = "accepted";
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(result.outcome).toBe("accepted");
    expect(result.reason).toBe(null);
    expect(result.messageId).not.toBeNull();
    expect(result.detail).toMatch(/accepted/);
    expect(result.detail).not.toMatch(/execut|complet|ran|finished/i);
  });

  it("a native rejection is reported as rejected with nothing queued", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    sendBehaviour = "rejected";
    const result = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("rejected");
    expect(result.messageId).toBe(null);
    expect(result.detail).toMatch(/refused.*nothing was queued/);
  });

  it("an unclear acknowledgement stays ambiguous and never claims a result", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    sendBehaviour = "unclear-shape";
    const shaped = await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    expect(shaped.outcome).toBe("ambiguous");
    expect(shaped.reason).toBe("ambiguous");
    expect(shaped.messageId).toBe(null);

    sendTransportError = "T3 request failed (503)";
    const transport = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: "req-2" }),
    );
    expect(transport.outcome).toBe("ambiguous");
    expect(transport.reason).toBe("ambiguous");
    expect(transport.detail).toMatch(/may or may not have been queued/);
  });

  it("maps a revoked grant mid-send to authorization_required", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    sendTransportError = "T3 request failed (401)";
    const revoked = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: "req-revoked" }),
    );
    expect(revoked).toMatchObject({ outcome: "rejected", reason: "authorization_required" });
    const rows = await t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() });
    expect(rows.find((row) => String(row.connectionId) === String(operateId))?.status).toBe("reauthorizationRequired");
  });

  it("maps a throttled send to rate_limited", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    sendTransportError = "T3 request failed (429)";
    const throttled = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: "req-throttled" }),
    );
    expect(throttled).toMatchObject({ outcome: "rejected", reason: "rate_limited" });
  });

  it("a replayed request id is reported from the thread activity, never from a guessed marker", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const first = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY }),
    );
    expect(first).toMatchObject({ outcome: "queued", dedupe: "not_duplicate_observed" });
    const replay = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY }),
    );
    // The native replay carried NO duplicate marker: the same message id, run
    // id, status and delivery. The evidence that no second message was
    // created is the thread activity: the replay added no item.
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.runId).toBe(first.runId);
    expect(replay.outcome).toBe("queued");
    expect(replay.dedupe).toBe("duplicate_observed");
    expect(createdMessages).toHaveLength(1);
    expect(sendCalls).toHaveLength(2);
    // Exactly one native activity item exists for this request id.
    expect(threadItems.get(testThreadId(1))).toHaveLength(1);
  });

  it("attributes a queued message that is not yet in the timeline through its run", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    // A queued message may not appear in the thread timeline yet. The run it
    // was given is still native evidence, and it is attributed by identity.
    materializeMessageItems = false;
    const first = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY }),
    );
    expect(first.outcome).toBe("queued");
    expect(first.dedupe).toBe("not_duplicate_observed");
    expect(threadItems.get(testThreadId(1)) ?? []).toHaveLength(0);
    expect(threadRuns.get(testThreadId(1))).toHaveLength(1);
    const replay = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY }),
    );
    // The replay left the same single run behind: no second activity.
    expect(replay.dedupe).toBe("duplicate_observed");
    expect(threadRuns.get(testThreadId(1))).toHaveLength(1);
    expect(createdMessages).toHaveLength(1);
  });

  it("an inconclusive thread read never claims a duplicate", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    failPostSendRead = true;
    const result = await authed(t).action(
      api.t3Send.send,
      sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY }),
    );
    // The acknowledgement stands; the duplicate question is reported as
    // unverified rather than claimed in either direction.
    expect(result.outcome).toBe("queued");
    expect(result.dedupe).toBe("unverified");
    expect(result.dedupe).not.toBe("not_duplicate_observed");
    expect(result.dedupe).not.toBe("duplicate_observed");
    expect(result.messageId).not.toBeNull();
  });

  it("never asks the native client for t3_thread_launch from this path", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId }));
    sendBehaviour = "queued";
    await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, clientRequestId: "req-q" }));
    sendBehaviour = "rejected";
    await authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, clientRequestId: "req-r" }));
    expect(toolNames).toContain("t3_thread_send");
    expect(toolNames).not.toContain("t3_thread_launch");
    expect(sendCalls.length).toBeGreaterThan(0);
    for (const call of sendCalls) expect(call.name).toBe("t3_thread_send");
  });

  it("concurrent independent threads each receive their own message and stay separate", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const threadA = testThreadId(1);
    const threadB = testThreadId(3);
    threadProjects.set(threadB, T3_PROJECT);
    const [resultA, resultB] = await Promise.all([
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, threadId: threadA, message: "message for A", clientRequestId: "req-a" })),
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, threadId: threadB, message: "message for B", clientRequestId: "req-b" })),
    ]);
    expect(resultA).toMatchObject({ outcome: "queued", threadId: threadA });
    expect(resultB).toMatchObject({ outcome: "queued", threadId: threadB });
    expect(resultA.messageId).not.toBe(resultB.messageId);
    const byThread = new Map(createdMessages.map((entry) => [entry.threadId, entry.messageId]));
    expect(byThread.get(threadA)).toBe(resultA.messageId);
    expect(byThread.get(threadB)).toBe(resultB.messageId);
    const argsA = sendCalls.find((call) => call.args.threadId === threadA)?.args;
    const argsB = sendCalls.find((call) => call.args.threadId === threadB)?.args;
    expect(argsA?.message).toBe("message for A");
    expect(argsB?.message).toBe("message for B");
  });

  it("duplicate rapid clicks with the same clientRequestId create one native message", async () => {
    const t = await granted();
    const operateId = await seedConnection(t, { access: "operate" });
    const clicks = await Promise.all([
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY })),
      authed(t).action(api.t3Send.send, sendInput({ connectionId: operateId, clientRequestId: DISTINCTIVE_KEY })),
    ]);
    // Both clicks resolve to the same native message; the native registry
    // created a single item, and Helm observed exactly one native activity
    // item for the request id.
    expect(createdMessages).toHaveLength(1);
    expect(clicks.map((result) => result.messageId)).toEqual([
      `message:mcp:client%3Ahelm-test-client:thread-send:${DISTINCTIVE_KEY}`,
      `message:mcp:client%3Ahelm-test-client:thread-send:${DISTINCTIVE_KEY}`,
    ]);
    expect(threadItems.get(testThreadId(1))).toHaveLength(1);
    for (const result of clicks) expect(result.dedupe).toBe("not_duplicate_observed");
  });

  it("the write tool helper still refuses a non-operate access before any network call", async () => {
    await expect(operateToolCall(ENDPOINT, "token", "read-only", "t3_thread_send", {})).rejects.toThrow(
      /operate access is required/,
    );
    expect(mock.connect).not.toHaveBeenCalled();
  });
});
