"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptStoredToken, operateToolCall } from "./t3OAuth";
import {
  OPERATE_REFUSAL_DETAIL,
  resolveOperateConnection,
  type OperateRefusal,
} from "./lib/operateGate";
import { SEND_REQUEST_INVALID, SEND_THREAD_MISMATCH, throwSendInvalid } from "./lib/sendErrors";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

/**
 * Explicit failure vocabulary for the native follow-up path. Every returned
 * failure carries one of these codes plus a fixed sanitized sentence — never
 * raw upstream text and never a token. Request-shape refusals (bad ids,
 * empty message, thread/project mismatch) are thrown as invalid-request
 * errors instead; see `convex/lib/sendErrors.ts`.
 */
const sendReason = v.union(
  v.literal("authorization_required"),
  v.literal("expired"),
  v.literal("unreachable"),
  v.literal("rate_limited"),
  v.literal("not_found"),
  v.literal("rejected"),
  v.literal("ambiguous"),
  v.literal("read_failed"),
);
type SendReason = Infer<typeof sendReason>;

/**
 * Duplicate/replay evidence states (EGA-764 D10).
 *
 * The native `t3_thread_send` acknowledgement has EXACTLY five keys —
 * `threadId`, `messageId`, `runId`, `status`, `delivery` — and NO duplicate
 * marker of any kind. The confirmed replay receipt returned the SAME
 * `messageId`, `runId`, `status` and `delivery` as the first send
 * (`doc/v0.2/evidence/ega-758-probe-receipts.json`: "follow-up.idempotency —
 * identical clientRequestId accepted; keys=threadId,messageId,runId,status,
 * delivery"). Helm therefore never infers a duplicate from the response
 * body: a guessed marker would either claim a dedupe that never happened or
 * miss a real one.
 *
 * The state below is derived ONLY from the thread activity Helm reads around
 * the send, and it describes what was OBSERVED, never what is assumed:
 *  - `not_duplicate_observed`: exactly one native activity item attributable
 *    to this request id appeared while the request was in flight;
 *  - `duplicate_observed`: this request id's activity already existed and no
 *    new item appeared, or more than one item is attributable to it;
 *  - `unverified`: the thread activity could not be attributed to this
 *    request id — the thread could not be re-read, the acknowledged identity
 *    is not visible in the thread, or the request id is too short to
 *    attribute safely.
 */
const dedupeState = v.union(
  v.literal("not_duplicate_observed"),
  v.literal("duplicate_observed"),
  v.literal("unverified"),
);
type DedupeState = Infer<typeof dedupeState>;

const sendReturns = v.object({
  outcome: v.union(v.literal("accepted"), v.literal("queued"), v.literal("rejected"), v.literal("ambiguous")),
  /** Null unless the outcome is `rejected` or `ambiguous`. */
  reason: v.union(sendReason, v.null()),
  /** Fixed sanitized sentence; safe to render. */
  detail: v.string(),
  /** The thread the caller asked about. Echoed only after shape validation. */
  threadId: v.string(),
  messageId: v.union(v.string(), v.null()),
  runId: v.union(v.string(), v.null()),
  /** Echo of the caller's idempotency key. Helm never mints or alters it. */
  clientRequestId: v.string(),
  /** What the thread activity showed about duplicates. Never asserted, only observed. */
  dedupe: dedupeState,
});
type SendResult = Infer<typeof sendReturns>;

type SendArgs = {
  connectionId: Id<"t3Connections">;
  projectId: string;
  threadId: string;
  message: string;
  clientRequestId: string;
};

type OperateConnection = {
  connectionId: Id<"t3Connections">;
  endpoint: string;
  environmentId: string;
  access: string;
  tokenCiphertext: string;
  credentialVersion: number;
};

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * The native `t3_thread_send` input contract allows `mode` to be
 * `auto | queue | steer | restart` (captured schema:
 * `doc/fixtures/t3-mcp-tools.schemas.json`; confirmed in
 * `doc/v0.2/EGA-758-write-capability-matrix.md`). Only `queue` means "add a
 * follow-up message to the thread": `steer` and `restart` change the running
 * turn and `auto` lets the native server choose. Helm sends `queue` verbatim
 * and never falls back to another mode.
 */
const SEND_MODE = "queue";

/**
 * A request id shorter than this is not distinctive enough to attribute a
 * thread activity item to it: an item id that merely CONTAINS a short key
 * ("1", "req-1") would match unrelated items. Attribution by request id is
 * therefore only attempted for a long, distinctive key.
 */
const DISTINCTIVE_REQUEST_ID_LENGTH = 16;

/**
 * Native refusal vocabulary Helm recognises on a send acknowledgement.
 *
 * The only native status a live probe observed is `queued`; a refusal has
 * never been observed. These are the words Helm treats as a refusal, and an
 * acknowledgement Helm does not recognise falls through to `ambiguous` — the
 * safe direction, because an ambiguous outcome is retried with the SAME
 * request id and the native server deduplicates it.
 */
const NATIVE_REFUSAL_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "failed",
  "error",
  "refused",
  "undelivered",
]);

function invalid(): never {
  return throwSendInvalid(SEND_REQUEST_INVALID);
}

function mismatch(): never {
  return throwSendInvalid(SEND_THREAD_MISMATCH);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid();
  return value as string;
}

function rejected(result: Omit<SendResult, "outcome" | "reason"> & { reason: SendReason }): SendResult {
  return { ...result, outcome: "rejected" as const };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map the shared operate-gate refusal onto this path's failure vocabulary. */
function gateRefusal(reason: OperateRefusal): SendReason {
  switch (reason) {
    case "operate_not_granted":
    case "reauthorization_required":
      return "authorization_required";
    case "operate_ambiguous":
      return "ambiguous";
    case "expired":
      return "expired";
    case "unreachable":
      return "unreachable";
    case "unusable":
      return "read_failed";
  }
}

const UNCLEAR_DETAIL =
  "The send acknowledgement was unclear; the message may or may not have been queued. Retry with the same request id.";

function unclear(threadId: string, clientRequestId: string, dedupe: DedupeState = "unverified"): SendResult {
  return {
    outcome: "ambiguous",
    reason: "ambiguous",
    detail: UNCLEAR_DETAIL,
    threadId,
    messageId: null,
    runId: null,
    clientRequestId,
    dedupe,
  };
}

/**
 * The native thread activity Helm reads to decide what it can honestly say
 * about duplicates. `items` are the thread timeline items (a user message is
 * one of them) and `recentRuns` are the thread's runs.
 */
type ThreadActivity = {
  itemIds: string[];
  runIds: string[];
};

/** Extract the thread activity from a decoded `t3_thread_read` result. */
function activityOf(detail: { items?: unknown; recentRuns?: unknown } | null): ThreadActivity | null {
  if (!detail || !Array.isArray(detail.items) || !Array.isArray(detail.recentRuns)) return null;
  const itemIds: string[] = [];
  for (const item of detail.items) {
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) itemIds.push(id);
  }
  const runIds: string[] = [];
  for (const run of detail.recentRuns) {
    if (typeof run !== "object" || run === null) continue;
    const runId = (run as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId.length > 0) runIds.push(runId);
  }
  return { itemIds, runIds };
}

/** Read the thread's activity. Returns null when the thread cannot be read. */
async function readThreadActivity(
  ctx: ActionCtx,
  connectionId: Id<"t3Connections">,
  threadId: string,
): Promise<ThreadActivity | null> {
  try {
    const detail = (await ctx.runAction(api.t3OAuth.read, {
      connectionId,
      operation: "thread",
      input: { threadId },
    })) as { items?: unknown; recentRuns?: unknown } | null;
    return activityOf(detail);
  } catch {
    return null;
  }
}

/**
 * The thread activity attributable to ONE request.
 *
 * Two attribution rules, each anchored in recorded evidence:
 *  - the acknowledged identity itself — the `messageId` the send returned
 *    (matched against thread items) and the `runId` it returned (matched
 *    against the thread's runs). The confirmed probe saw the same
 *    `run:thread:<threadId>:ordinal:<n>` shape on the send acknowledgement
 *    and in the thread's runs;
 *  - the request id embedded in a thread item id. EGA-677 recorded that the
 *    returned `messageId` embeds the supplied `clientRequestId`
 *    (`doc/proof/ega677-results.md`), so a second native message created
 *    under the same key is visible as a second attributable item.
 *
 * The embedded rule only applies to a request id long enough to be
 * distinctive; a short key would match unrelated items and invent a
 * duplicate that never happened.
 */
function attributable(
  activity: ThreadActivity | null,
  request: { clientRequestId: string; messageId: string | null; runId: string | null },
): { items: Set<string>; runs: Set<string> } {
  const items = new Set<string>();
  const runs = new Set<string>();
  if (!activity) return { items, runs };
  const useEmbeddedKey = request.clientRequestId.length >= DISTINCTIVE_REQUEST_ID_LENGTH;
  for (const id of activity.itemIds) {
    if (request.messageId !== null && id === request.messageId) items.add(id);
    else if (useEmbeddedKey && id.includes(request.clientRequestId)) items.add(id);
  }
  for (const id of activity.runIds) {
    if (request.runId !== null && id === request.runId) runs.add(id);
  }
  return { items, runs };
}

/**
 * Decide what the thread activity actually showed. This never asserts that a
 * duplicate did or did not happen; it reports what was observed, and returns
 * `unverified` whenever the observation is inconclusive.
 */
function classifyDedupe(
  before: ThreadActivity | null,
  after: ThreadActivity | null,
  request: { clientRequestId: string; messageId: string | null; runId: string | null },
): DedupeState {
  // Without both snapshots Helm cannot say what appeared DURING the request,
  // so it says nothing.
  if (!after || !before) return "unverified";
  const now = attributable(after, request);
  const then = attributable(before, request);
  if (now.items.size > 1) return "duplicate_observed";
  if (now.items.size === 1) {
    const [only] = [...now.items];
    return then.items.has(only!) ? "duplicate_observed" : "not_duplicate_observed";
  }
  // The message itself may not be materialised yet (a queued message can sit
  // in the queue before it appears in the timeline). The run is the weaker
  // but still native signal that the request produced one run.
  if (now.runs.size > 1) return "duplicate_observed";
  if (now.runs.size === 1) {
    const [only] = [...now.runs];
    return then.runs.has(only!) ? "duplicate_observed" : "not_duplicate_observed";
  }
  return "unverified";
}

/**
 * Owner-gated native T3 follow-up send (EGA-764 D10).
 *
 * Order is deliberate:
 *   0. owner grant gate — no work and no external access without it;
 *   1. validate the reviewed request shape (no network);
 *   2. resolve the single usable `operate` connection through the SHARED gate
 *      (`convex/lib/operateGate.ts`) — a read-only inventory refuses BEFORE
 *      any network call, and `operateToolCall` re-checks at the tool boundary;
 *   3. bind the caller's connection choice to the resolved grant (a caller
 *      connection that is not the operate grant refuses);
 *   4. bind the thread to the project NATIVELY: read the thread with
 *      `t3_thread_read` and compare the returned `projectId`/`threadId`
 *      against the request — a mismatch refuses and nothing is ever sent;
 *      the same read is the BEFORE snapshot for the duplicate check;
 *   5. send exactly once via the write allowlist (`t3_thread_send` only, in
 *      the documented `queue` mode — steer/restart semantics do not exist on
 *      this path);
 *   6. derive the envelope from the native acknowledgement, using ONLY the
 *      five confirmed native fields (`threadId`, `messageId`, `runId`,
 *      `status`, `delivery`);
 *   7. re-read the thread and report what its activity actually showed about
 *      duplicates — `not_duplicate_observed`, `duplicate_observed`, or
 *      `unverified`. The native response carries no duplicate marker, so
 *      nothing is ever asserted that the thread did not show.
 *
 * No thread is ever launched from this path: the native client is only ever
 * asked for `t3_thread_send` (plus the binding `t3_thread_read`).
 */
export const send = action({
  args: {
    connectionId: v.id("t3Connections"),
    projectId: v.string(),
    threadId: v.string(),
    message: v.string(),
    clientRequestId: v.string(),
  },
  returns: sendReturns,
  handler: async (ctx: ActionCtx, args: SendArgs): Promise<SendResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });

    // 1. Shape checks fail before any database or network access.
    const projectId = boundedText(args.projectId.trim(), 1024);
    const threadId = boundedText(args.threadId.trim(), 128);
    const message = boundedText(args.message, 8000);
    if (!CLIENT_REQUEST_ID_PATTERN.test(args.clientRequestId)) invalid();
    const clientRequestId = args.clientRequestId;
    await assertOwnerCurrent();

    const failed = (
      reason: SendReason,
      detail: string,
    ): SendResult => ({
      outcome: "rejected",
      reason,
      detail,
      threadId,
      messageId: null,
      runId: null,
      clientRequestId,
      dedupe: "unverified",
    });

    // 2. The separately-authorised `operate` connection, resolved through the
    // single shared gate. A read-only inventory refuses here, before any
    // network call, and `operateToolCall` re-checks at the tool boundary.
    const connections: { connectionId: Id<"t3Connections">; access: string; status: string; environmentId: string }[] =
      await ctx.runQuery(internal.t3ConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
    const verdict = resolveOperateConnection(
      connections.map((row) => ({
        connectionId: String(row.connectionId),
        access: row.access,
        status: row.status,
        environmentId: row.environmentId,
      })),
    );
    if (!verdict.ok) {
      return failed(gateRefusal(verdict.reason), OPERATE_REFUSAL_DETAIL[verdict.reason]);
    }

    // 3. The caller's connection choice must BE the resolved operate grant.
    // The stored grant identity is compared, never trusted from the caller.
    if (String(args.connectionId) !== verdict.connectionId) {
      return failed("rejected", "The selected connection is not the authorized operate connection; no message was sent.");
    }

    const secret: (OperateConnection & { status: string; credentialVersion: number }) | null = await ctx.runQuery(
      internal.t3ConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner),
        connectionId: args.connectionId,
        now: Date.now(),
      },
    );
    if (!secret || secret.access !== "operate") {
      return failed("authorization_required", "T3 operate access is unavailable; complete the operate consent first.");
    }
    if (secret.status !== "connected") {
      const reason: SendReason =
        secret.status === "expired"
          ? "expired"
          : secret.status === "unreachable"
            ? "unreachable"
            : secret.status === "reauthorizationRequired"
              ? "authorization_required"
              : "read_failed";
      const detail =
        reason === "expired"
          ? "T3 connection has expired; reconnect it to continue."
          : reason === "unreachable"
            ? "T3 connection is unreachable; refresh it before sending."
            : reason === "authorization_required"
              ? "T3 authorization was revoked; reconnect to continue."
              : "T3 operate connection is not usable; reconnect it to continue.";
      return rejected({
        reason,
        detail,
        threadId,
        messageId: null,
        runId: null,
        clientRequestId,
        dedupe: "unverified",
      });
    }

    const assertConnectionCurrent = (): Promise<boolean> =>
      ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, {
        ...storeOwner(owner),
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
      });
    /**
     * L-1 checkpoints: the owner grant is revalidated BEFORE the MCP
     * transport is constructed (the bearer token is transmitted during
     * initialization) and again immediately before the tool call itself.
     */
    const guards = {
      beforeConnect: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the send was in progress");
      },
      beforeCall: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the send was in progress");
      },
    };
    const markReauthorizationRequired = (): Promise<null> =>
      ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner),
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
        at: Date.now(),
        status: "reauthorizationRequired",
        errorCode: "authorization_required",
      });

    // 4. Identity binding, natively: the thread is read and its returned
    // project/thread identity is compared against the request. A mismatch
    // refuses — the send below can never reach a thread the caller did not
    // prove it selected. This runs after the operate gates so those refusals
    // keep their reasons, and before the first write. The same read is the
    // BEFORE snapshot for the duplicate check in step 7.
    await assertOwnerCurrent();
    let beforeActivity: ThreadActivity | null;
    try {
      const detail = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "thread",
        input: { threadId },
      }) as { thread?: { threadId?: unknown; projectId?: unknown }; items?: unknown; recentRuns?: unknown };
      const returnedThreadId = detail.thread?.threadId;
      const returnedProjectId = detail.thread?.projectId;
      if (typeof returnedThreadId !== "string" || returnedThreadId !== threadId) mismatch();
      if (typeof returnedProjectId !== "string" || returnedProjectId !== projectId) mismatch();
      beforeActivity = activityOf(detail);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "";
      if (messageText === SEND_THREAD_MISMATCH || /different thread than requested|different project/i.test(messageText)) {
        mismatch();
      }
      if (/T3 request failed \((401|403)\)/.test(messageText)) {
        await markReauthorizationRequired();
        return failed("authorization_required", "T3 authorization was revoked; reconnect to continue.");
      }
      if (/T3 request failed \(404\)/.test(messageText)) {
        return failed("not_found", "That thread is no longer available; reselect it before sending.");
      }
      if (/T3 request failed \(429\)/.test(messageText)) {
        return failed("rate_limited", "T3 is receiving too many requests; try again shortly.");
      }
      if (/could not be reached|timed out|T3 request failed \(5\d\d\)/i.test(messageText)) {
        return failed("unreachable", "The T3 endpoint could not be reached; try again later.");
      }
      if (messageText.startsWith("unauthorized:") || messageText.includes("changed while the send was in progress")) {
        throw error;
      }
      return failed("read_failed", "The selected thread could not be read; reselect it before sending.");
    }

    // 5. Send exactly once through the write allowlist, in the documented
    // `queue` mode. The grant is revalidated BEFORE the MCP transport is
    // constructed and again at the tool boundary. `operateToolCall` forwards
    // the arguments verbatim: no other mode is ever substituted.
    const token = decryptStoredToken(secret.tokenCiphertext, { issuer: owner.issuer, subject: owner.subject }, secret.endpoint);
    await guards.beforeConnect();
    let response: Record<string, unknown>;
    try {
      response = await operateToolCall(secret.endpoint, token, secret.access, "t3_thread_send", {
        threadId,
        message,
        clientRequestId,
        mode: SEND_MODE,
      }, guards.beforeCall);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "";
      // An owner-grant or credential race mid-flight is a fail-closed stop,
      // not a send outcome: the guards throw before the tool call, so no
      // send was issued. Never pause anything on this path, just stop.
      if (messageText.startsWith("unauthorized:") || messageText.includes("changed while the send was in progress")) {
        throw error;
      }
      if (/T3 request failed \((401|403)\)/.test(messageText)) {
        await markReauthorizationRequired();
        return failed("authorization_required", "T3 authorization was revoked; reconnect to continue.");
      }
      if (/T3 request failed \(404\)/.test(messageText)) {
        return failed("not_found", "That thread is no longer available; reselect it before sending.");
      }
      if (/T3 request failed \(429\)/.test(messageText)) {
        await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
          ...storeOwner(owner),
          connectionId: secret.connectionId,
          credentialVersion: secret.credentialVersion,
          at: Date.now(),
          errorCode: "rate_limited",
        });
        return failed("rate_limited", "T3 is receiving too many requests; try again shortly.");
      }
      if (/could not be reached|timed out|T3 request failed \(5\d\d\)/i.test(messageText)) {
        return unclear(threadId, clientRequestId);
      }
      return unclear(threadId, clientRequestId);
    }

    // 6. Derive the envelope from the native acknowledgement. ONLY the five
    // confirmed native fields are read: `threadId`, `messageId`, `runId`,
    // `status`, `delivery`. There is no duplicate marker in the native
    // contract, so none is looked for here.
    const returnedThreadId = nullableString(response.threadId);
    if (returnedThreadId !== null && returnedThreadId !== threadId) {
      return unclear(threadId, clientRequestId);
    }
    const messageId = nullableString(response.messageId);
    const runId = nullableString(response.runId);
    const statusText = typeof response.status === "string" ? response.status.trim().toLowerCase() : "";
    const deliveryText = typeof response.delivery === "string" ? response.delivery.trim().toLowerCase() : "";
    // A refusal is reported as a refusal; an acknowledgement Helm cannot
    // classify is reported as ambiguous, never as a success.
    const refused = NATIVE_REFUSAL_STATUSES.has(statusText) || NATIVE_REFUSAL_STATUSES.has(deliveryText);
    // `queued` is the only native queueing value a live probe observed.
    const queued = statusText === "queued" || deliveryText === "queued";

    // 7. Re-read the thread and report what its activity actually showed.
    // A failed re-read is not a send failure: the acknowledgement stands and
    // the duplicate question is reported as unverified.
    const afterActivity = await readThreadActivity(ctx, secret.connectionId, threadId);
    const dedupe = classifyDedupe(beforeActivity, afterActivity, { clientRequestId, messageId, runId });

    if (refused) {
      return rejected({
        reason: "rejected",
        detail: "T3 refused the follow-up message; nothing was queued.",
        threadId,
        messageId: null,
        runId,
        clientRequestId,
        dedupe,
      });
    }
    if (queued) {
      return {
        outcome: "queued",
        reason: null,
        detail: "T3 queued the follow-up message; it has not run yet.",
        threadId,
        messageId,
        runId,
        clientRequestId,
        dedupe,
      };
    }
    if (messageId !== null) {
      return {
        outcome: "accepted",
        reason: null,
        detail: "T3 accepted the follow-up message.",
        threadId,
        messageId,
        runId,
        clientRequestId,
        dedupe,
      };
    }
    // The acknowledgement carried no usable identity: the outcome stays
    // ambiguous, and the thread observation (if any) is reported as it was.
    return unclear(threadId, clientRequestId, dedupe);
  },
});
