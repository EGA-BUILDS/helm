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
  /**
   * True ONLY when the native response itself proves the replay was
   * deduplicated (an explicit duplicate marker). Helm keeps no replay store
   * on this path, so absent that marker this stays false: a second send with
   * the same key is reported as its own accepted/queued outcome, never as a
   * suppressed duplicate.
   */
  duplicateSuppressed: v.boolean(),
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

function unclear(threadId: string, clientRequestId: string): SendResult {
  return {
    outcome: "ambiguous",
    reason: "ambiguous",
    detail: UNCLEAR_DETAIL,
    threadId,
    messageId: null,
    runId: null,
    clientRequestId,
    duplicateSuppressed: false,
  };
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
 *   5. send exactly once via the write allowlist (`t3_thread_send` only, in
 *      the documented `queue` mode — steer/restart semantics do not exist on
 *      this path);
 *   6. derive the envelope from the native acknowledgement: `accepted` means
 *      a message item exists (never "executed"), `queued` means acknowledged
 *      for later, `rejected` means nothing was queued, `ambiguous` means the
 *      acknowledgement was unclear.
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
      duplicateSuppressed: false,
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
        duplicateSuppressed: false,
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
    // keep their reasons, and before the first write.
    await assertOwnerCurrent();
    let boundProjectId: string;
    try {
      const detail = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "thread",
        input: { threadId },
      }) as { thread?: { threadId?: unknown; projectId?: unknown } };
      const returnedThreadId = detail.thread?.threadId;
      const returnedProjectId = detail.thread?.projectId;
      if (typeof returnedThreadId !== "string" || returnedThreadId !== threadId) mismatch();
      if (typeof returnedProjectId !== "string" || returnedProjectId !== projectId) mismatch();
      boundProjectId = returnedProjectId;
      void boundProjectId;
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
    // constructed and again at the tool boundary.
    const token = decryptStoredToken(secret.tokenCiphertext, { issuer: owner.issuer, subject: owner.subject }, secret.endpoint);
    await guards.beforeConnect();
    let response: Record<string, unknown>;
    try {
      response = await operateToolCall(secret.endpoint, token, secret.access, "t3_thread_send", {
        threadId,
        message,
        clientRequestId,
        mode: "queue",
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

    // 6. Derive the envelope from the native acknowledgement. Only an explicit
    // native duplicate marker proves a replay was deduplicated; anything else
    // is reported as its own outcome.
    const returnedThreadId = nullableString(response.threadId);
    if (returnedThreadId !== null && returnedThreadId !== threadId) {
      return unclear(threadId, clientRequestId);
    }
    const messageId = nullableString(response.messageId);
    const runId = nullableString(response.runId);
    const statusText = typeof response.status === "string" ? response.status.toLowerCase() : "";
    const deliveryText = typeof response.delivery === "string" ? response.delivery.toLowerCase() : "";
    const duplicateSuppressed =
      response.deduplicated === true ||
      response.duplicate === true ||
      statusText === "duplicate" ||
      deliveryText === "duplicate" ||
      deliveryText === "deduplicated" ||
      deliveryText === "already_delivered";
    if (statusText === "rejected" || statusText === "failed" || statusText === "error" ||
        deliveryText === "rejected" || deliveryText === "failed" || deliveryText === "undelivered") {
      return rejected({
        reason: "rejected",
        detail: "T3 refused the follow-up message; nothing was queued.",
        threadId,
        messageId: null,
        runId,
        clientRequestId,
        duplicateSuppressed: false,
      });
    }
    if (messageId !== null) {
      return {
        outcome: "accepted",
        reason: null,
        detail: duplicateSuppressed
          ? "T3 already held this message under the same request id; no second message was created."
          : "T3 accepted the follow-up message.",
        threadId,
        messageId,
        runId,
        clientRequestId,
        duplicateSuppressed,
      };
    }
    if (statusText === "queued" || statusText === "pending" || statusText === "scheduled" || statusText === "accepted" ||
        deliveryText === "queued" || deliveryText === "pending" || deliveryText === "scheduled" || deliveryText === "accepted") {
      return {
        outcome: "queued",
        reason: null,
        detail: "T3 queued the follow-up message; it has not run yet.",
        threadId,
        messageId: null,
        runId,
        clientRequestId,
        duplicateSuppressed: false,
      };
    }
    return unclear(threadId, clientRequestId);
  },
});
