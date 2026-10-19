"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { decryptStoredToken, operateToolCall } from "./t3OAuth";
import { resolveOperateConnection } from "./lib/operateGate";
import { classifyRunStatus } from "./lib/runStatus";
import { INTERRUPT_REQUEST_INVALID } from "./lib/interruptErrors";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

/**
 * Explicit failure vocabulary for the native interrupt path. Every returned
 * failure carries one of these codes plus a fixed sanitized sentence — never
 * raw upstream text and never a token. Request-shape refusals (bad ids) are
 * thrown as invalid-request errors instead; see
 * `convex/lib/interruptErrors.ts`.
 *
 * Outcome decision table (decided server-side, in this order):
 *   - `rejected` — permission/identity/evidence refusal BEFORE any interrupt
 *     call: no operate grant (missing/ambiguous/revoked/expired/unreachable),
 *     the requested connection is not the operate grant, the native thread
 *     belongs to a different project, or the runId is not a run of this
 *     thread (stale or cross-thread — never interrupts a different run).
 *   - `no_active_run` — neutral: the thread legitimately has no runs (idle).
 *     Deletes nothing, errors nothing.
 *   - `already_terminal` — neutral: the observed run is already terminal, or
 *     an interrupt is already in flight for it. No second call is issued.
 *   - `requested` — the interrupt call was accepted AND the native answer
 *     was exactly `interrupt_requested`. Requested means REQUESTED: the
 *     detail never describes it as verified termination.
 *   - `ambiguous` — the run state or the acknowledgement could not be
 *     verified (unknown run status, echo mismatch, unclear ack, failed
 *     verification read). No retry is ever issued from this path.
 */
const interruptReason = v.union(
  v.literal("authorization_required"),
  v.literal("expired"),
  v.literal("unreachable"),
  v.literal("rate_limited"),
  v.literal("invalid_run"),
  v.literal("project_mismatch"),
  v.literal("already_terminal"),
  v.literal("no_active_run"),
  v.literal("ambiguous"),
  v.literal("read_failed"),
);
type InterruptReason = Infer<typeof interruptReason>;

const interruptOutcome = v.union(
  v.literal("requested"),
  v.literal("already_terminal"),
  v.literal("no_active_run"),
  v.literal("rejected"),
  v.literal("ambiguous"),
);
type InterruptOutcome = Infer<typeof interruptOutcome>;

const interruptReturns = v.object({
  outcome: interruptOutcome,
  /** Null only when the outcome is `requested`. */
  reason: v.union(interruptReason, v.null()),
  /** Fixed sanitized sentence; safe to render. */
  detail: v.string(),
  threadId: v.union(v.string(), v.null()),
  runId: v.union(v.string(), v.null()),
  observedAt: v.string(),
  /** Where the owner can act in T3; always present so a refusal still hands off. */
  t3Reference: v.string(),
});
type InterruptResult = Infer<typeof interruptReturns>;

type InterruptArgs = {
  connectionId: Id<"t3Connections">;
  projectId: string;
  threadId: string;
  runId: string;
  reason?: string;
  clientRequestId?: string;
};

type OperateSecret = {
  connectionId: Id<"t3Connections">;
  endpoint: string;
  environmentId: string;
  access: string;
  tokenCiphertext: string;
  credentialVersion: number;
  status: string;
};

const RUN_ID_PATTERN = /^[^\s]{1,512}$/u;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function invalid(): never {
  throw new Error(INTERRUPT_REQUEST_INVALID);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid();
  return value as string;
}

/** Owner handoff: which T3 thread to open. Never a token, never a secret. */
function t3ReferenceFor(projectId: string, threadId: string): string {
  return `Open T3 thread ${threadId} in project ${projectId} to review and act.`;
}

function envelope(
  outcome: InterruptOutcome,
  reason: InterruptReason | null,
  detail: string,
  ids: { projectId: string; threadId: string; runId: string | null },
): InterruptResult {
  return {
    outcome,
    reason,
    detail,
    threadId: ids.threadId,
    runId: ids.runId,
    observedAt: new Date().toISOString(),
    t3Reference: t3ReferenceFor(ids.projectId, ids.threadId),
  };
}

function rejected(
  reason: InterruptReason,
  detail: string,
  ids: { projectId: string; threadId: string; runId: string | null },
): InterruptResult {
  return envelope("rejected", reason, detail, ids);
}

type ThreadReadView = {
  thread: { threadId: string; projectId: string; status: string | null };
  recentRuns: { runId: string; status: string | null }[];
};

function threadReadView(value: unknown): ThreadReadView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  const thread = page.thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const view = thread as Record<string, unknown>;
  if (typeof view.threadId !== "string" || typeof view.projectId !== "string") return null;
  const runs = page.recentRuns;
  if (!Array.isArray(runs)) return null;
  const recentRuns: ThreadReadView["recentRuns"] = [];
  for (const entry of runs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const run = entry as Record<string, unknown>;
    if (typeof run.runId !== "string") return null;
    if (run.status !== null && run.status !== undefined && typeof run.status !== "string") return null;
    recentRuns.push({ runId: run.runId, status: (run.status as string | null) ?? null });
  }
  const status = view.status;
  if (status !== null && status !== undefined && typeof status !== "string") return null;
  return {
    thread: { threadId: view.threadId, projectId: view.projectId, status: (status as string | null) ?? null },
    recentRuns,
  };
}

/**
 * Owner-gated native T3 run interrupt (EGA-765 v0.2 D11).
 *
 * Order is deliberate:
 *   0. owner grant gate — no work and no external access without it;
 *   1. validate the request shape (no network, no database);
 *   2. resolve the separately-authorised `operate` connection via the shared
 *      `resolveOperateConnection` gate, and require the requested connection
 *      to BE that grant — a read-only connection can never satisfy this step
 *      (anything else refuses BEFORE any network call);
 *   3. revalidate the owner grant, then read the thread NATIVELY and verify it
 *      belongs to `projectId`;
 *   4. recheck the current native run identity/status server-side: the runId
 *      must be a real run of THIS thread and still active. Stale or
 *      cross-thread ids are refused; terminal or in-flight runs return a
 *      neutral outcome; an idle thread returns a neutral outcome. None of
 *      these perform an interrupt call, delete anything, or retry;
 *   5. interrupt exactly once via the write allowlist (`t3_thread_interrupt`
 *      only — this module never names the native launch or send tools);
 *   6. report honestly: `interrupt_requested` is reported as REQUESTED, never
 *      as verified termination. Anything unclear stays `ambiguous` and is
 *      never retried here.
 *
 * This path performs no Linear access, no mutation of any stored row (except
 * recording a revoked grant when T3 says 401/403), and never deletes a
 * worktree or a thread.
 */
export const interrupt = action({
  args: {
    connectionId: v.id("t3Connections"),
    projectId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    reason: v.optional(v.string()),
    clientRequestId: v.optional(v.string()),
  },
  returns: interruptReturns,
  handler: async (ctx: ActionCtx, args: InterruptArgs): Promise<InterruptResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });

    // 1. Shape checks fail before any database or network access.
    const projectId = boundedText(args.projectId.trim(), 256);
    const threadId = boundedText(args.threadId, 128);
    if (!isValidT3ThreadId(threadId)) invalid();
    const runId = boundedText(args.runId, 512);
    if (!RUN_ID_PATTERN.test(runId)) invalid();
    let reason: string | undefined;
    if (args.reason !== undefined) {
      reason = boundedText(args.reason, 280);
    }
    let clientRequestId: string | undefined;
    if (args.clientRequestId !== undefined) {
      if (!CLIENT_REQUEST_ID_PATTERN.test(args.clientRequestId)) invalid();
      clientRequestId = args.clientRequestId;
    }
    const ids = { projectId, threadId, runId };
    await assertOwnerCurrent();

    // 2. The separately-authorised operate connection, resolved through the
    // shared gate so this path can never drift from the launch/send decision.
    // A read-only connection can never satisfy this step — the checks below
    // refuse it before any network call, and `operateToolCall` re-checks at
    // the tool boundary.
    const inventory: { connectionId: Id<"t3Connections">; access: string; status: string; environmentId: string }[] =
      await ctx.runQuery(internal.t3ConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
    const gate = resolveOperateConnection(
      inventory.map((row) => ({
        connectionId: String(row.connectionId),
        access: row.access,
        status: row.status,
        environmentId: row.environmentId,
      })),
    );
    if (!gate.ok) {
      switch (gate.reason) {
        case "operate_not_granted":
          return rejected("authorization_required", gate.detail, ids);
        case "operate_ambiguous":
          return envelope("ambiguous", "ambiguous", gate.detail, ids);
        case "expired":
          return rejected("expired", gate.detail, ids);
        case "reauthorization_required":
          return rejected("authorization_required", gate.detail, ids);
        case "unreachable":
          return rejected("unreachable", gate.detail, ids);
        case "unusable":
          return rejected("read_failed", gate.detail, ids);
      }
    }
    if (gate.connectionId !== String(args.connectionId)) {
      return rejected(
        "authorization_required",
        "The requested connection is not the operate grant; complete the operate consent first.",
        ids,
      );
    }

    const secret: OperateSecret | null = await ctx.runQuery(
      internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: args.connectionId, now: Date.now() },
    );
    if (!secret || secret.access !== "operate") {
      return rejected(
        "authorization_required",
        "T3 operate access is unavailable; complete the operate consent first.",
        ids,
      );
    }
    if (secret.status === "expired") {
      return rejected("expired", "T3 connection has expired; reconnect it to continue.", ids);
    }
    if (secret.status === "reauthorizationRequired") {
      return rejected("authorization_required", "T3 authorization was revoked; reconnect to continue.", ids);
    }
    if (secret.status === "unreachable") {
      return rejected("unreachable", "T3 connection is unreachable; refresh it before interrupting.", ids);
    }
    if (secret.status !== "connected") {
      return rejected("read_failed", "T3 operate connection is not usable; reconnect it to continue.", ids);
    }

    const assertConnectionCurrent = (): Promise<boolean> =>
      ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, {
        ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
      });
    /**
     * L-1 checkpoints: the owner grant is revalidated BEFORE the MCP
     * transport is constructed (the bearer token is transmitted during
     * initialization) and again immediately before the tool call itself.
     */
    const guards = {
      beforeConnect: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the interrupt was in progress");
      },
      beforeCall: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the interrupt was in progress");
      },
    };
    const markReauthorizationRequired = (): Promise<null> =>
      ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
        at: Date.now(), status: "reauthorizationRequired", errorCode: "authorization_required",
      });

    // 3. Read the thread natively and verify it belongs to projectId. A
    // cross-project thread is refused — never interrupted.
    await assertOwnerCurrent();
    let detail: ThreadReadView;
    try {
      const page: unknown = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "thread",
        input: { threadId },
      });
      const view = threadReadView(page);
      if (!view || view.thread.threadId !== threadId) {
        return envelope(
          "ambiguous", "ambiguous",
          "The thread state could not be verified; no interruption was issued.",
          ids,
        );
      }
      detail = view;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // A revoked grant mid-flight is a refusal with a specific reason (and
      // is recorded so the connection stops looking usable). Any other read
      // failure is lost evidence, so the honest outcome is ambiguous: the
      // thread state could not be verified and no interruption was issued.
      if (/T3 request failed \((401|403)\)/.test(message)) {
        await markReauthorizationRequired();
        return rejected("authorization_required", "T3 authorization was revoked; reconnect to continue.", ids);
      }
      return envelope(
        "ambiguous", "ambiguous",
        "The thread state could not be verified; no interruption was issued.",
        ids,
      );
    }
    if (detail.thread.projectId !== projectId) {
      return rejected(
        "project_mismatch",
        "T3 returned a thread from a different project; no interruption was issued.",
        ids,
      );
    }

    // 4. Recheck the current native run identity/status server-side. The
    // runId must be a real run of THIS thread and still active.
    if (detail.recentRuns.length === 0) {
      return envelope(
        "no_active_run", "no_active_run",
        "That thread has no active run; nothing was interrupted and nothing was deleted.",
        { ...ids, runId: null },
      );
    }
    const target = detail.recentRuns.find((run) => run.runId === runId) ?? null;
    if (!target) {
      // Stale id, or a run from another thread: refuse. Never interrupt a
      // different run.
      return rejected(
        "invalid_run",
        "That run is not a run of this thread; no interruption was issued.",
        ids,
      );
    }
    const kind = classifyRunStatus(target.status);
    if (kind === "terminal") {
      return envelope(
        "already_terminal", "already_terminal",
        "That run already reached a terminal state; no interruption was issued.",
        ids,
      );
    }
    if (kind === "inflight_interrupt") {
      return envelope(
        "already_terminal", "already_terminal",
        "An interrupt was already requested for that run; no second request was issued.",
        ids,
      );
    }
    if (kind === "unknown") {
      return envelope(
        "ambiguous", "ambiguous",
        "That run's state could not be verified; no interruption was issued.",
        ids,
      );
    }

    // 5. Interrupt exactly once through the write allowlist. The grant is
    // revalidated BEFORE the MCP transport is constructed — the bearer token
    // is transmitted during initialization — and again at the tool boundary.
    const token = decryptStoredToken(secret.tokenCiphertext, { issuer: owner.issuer, subject: owner.subject }, secret.endpoint);
    await guards.beforeConnect();
    let response: Record<string, unknown>;
    try {
      response = await operateToolCall(secret.endpoint, token, secret.access, "t3_thread_interrupt", {
        threadId,
        runId,
        ...(reason === undefined ? {} : { reason }),
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      }, guards.beforeCall);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // An owner-grant or credential race mid-flight is a fail-closed stop,
      // not an interrupt outcome: the guards throw before the tool call, so
      // no interrupt was issued and there is nothing to reconcile. Never
      // pause anything on this path, just stop.
      if (message.startsWith("unauthorized:") || message.includes("changed while the interrupt was in progress")) {
        throw error;
      }
      if (/T3 request failed \((401|403)\)/.test(message)) {
        await markReauthorizationRequired();
        return rejected("authorization_required", "T3 authorization was revoked; reconnect to continue.", ids);
      }
      if (/T3 request failed \(429\)/.test(message)) {
        return rejected("rate_limited", "T3 is receiving too many requests; try again shortly.", ids);
      }
      if (/could not be reached|timed out|T3 request failed \(5\d\d\)/i.test(message)) {
        return rejected("unreachable", "The T3 endpoint could not be reached; try again later.", ids);
      }
      return envelope(
        "ambiguous", "ambiguous",
        "The interrupt acknowledgement was unclear; the run state could not be verified. No retry was issued.",
        ids,
      );
    }

    // 6. Report honestly. `interrupt_requested` means the request was
    // accepted — never describe it as verified termination.
    const echoedThreadId = typeof response.threadId === "string" ? response.threadId : null;
    const echoedRunId = typeof response.runId === "string" ? response.runId : null;
    const echoedStatus = typeof response.status === "string" ? response.status : null;
    if (echoedThreadId !== threadId || echoedRunId !== runId || echoedStatus === null) {
      return envelope(
        "ambiguous", "ambiguous",
        "The interrupt acknowledgement was unclear; the run state could not be verified. No retry was issued.",
        ids,
      );
    }
    if (echoedStatus === "interrupt_requested") {
      return envelope(
        "requested", null,
        "Interrupt requested. T3 reported interrupt_requested: the request was accepted, not verified as terminated.",
        ids,
      );
    }
    if (classifyRunStatus(echoedStatus) === "terminal") {
      return envelope(
        "already_terminal", "already_terminal",
        "T3 now reports the run in a terminal state; no further interruption was issued.",
        ids,
      );
    }
    return envelope(
      "ambiguous", "ambiguous",
      "The interrupt acknowledgement was unclear; the run state could not be verified. No retry was issued.",
      ids,
    );
  },
});
