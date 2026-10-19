"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { classifyRunStatus } from "./lib/runStatus";
import { INTERRUPT_REQUEST_INVALID } from "./lib/interruptErrors";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const attentionState = v.union(
  v.literal("needs_attention"),
  v.literal("running"),
  v.literal("idle"),
  v.literal("unknown"),
);
type AttentionState = Infer<typeof attentionState>;

const attentionReturns = v.object({
  state: attentionState,
  /** What native evidence the state was derived from; sanitized, safe to render. */
  basis: v.string(),
  observedAt: v.string(),
  /** Where the owner can act in T3; always present so attention always hands off. */
  t3Reference: v.string(),
});
type AttentionResult = Infer<typeof attentionReturns>;

type AttentionArgs = {
  connectionId: Id<"t3Connections">;
  projectId: string;
  threadId: string;
};

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

function result(state: AttentionState, basis: string, ids: { projectId: string; threadId: string }): AttentionResult {
  return {
    state,
    basis,
    observedAt: new Date().toISOString(),
    t3Reference: t3ReferenceFor(ids.projectId, ids.threadId),
  };
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
 * Owner-gated attention derivation for one T3 thread (EGA-765 v0.2 D11).
 *
 * Read-only: no mutation, no interrupt, no launch, no send, no deletion.
 * Either access level (`read-only` or `operate`) may observe; the owner
 * grant is still required.
 *
 * `needs_attention` is returned ONLY when native evidence justifies it: an
 * active run whose status shows it is waiting (approval, input, paused,
 * blocked). A healthy active run is `running`; a thread with no live runs
 * is `idle`.
 *
 * The pending-request API (`t3_pending_request_list`) is not reachable over
 * the external grant, so pending approvals cannot be observed from here. When
 * the available evidence cannot decide — unreadable connection, failed or
 * mismatched thread read, or runs with no status at all — the answer is
 * `unknown` with a T3 handoff reference, never an invented state and never
 * an invented approval-response API.
 */
export const attention = action({
  args: {
    connectionId: v.id("t3Connections"),
    projectId: v.string(),
    threadId: v.string(),
  },
  returns: attentionReturns,
  handler: async (ctx: ActionCtx, args: AttentionArgs): Promise<AttentionResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });

    const projectId = boundedText(args.projectId.trim(), 256);
    const threadId = boundedText(args.threadId, 128);
    if (!isValidT3ThreadId(threadId)) invalid();
    const ids = { projectId, threadId };
    await assertOwnerCurrent();

    const secret = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
      ...storeOwner(owner), connectionId: args.connectionId, now: Date.now(),
    });
    if (!secret) {
      return result(
        "unknown",
        "That T3 connection is unavailable; open the T3 thread reference to review it directly.",
        ids,
      );
    }
    if (secret.status !== "connected") {
      return result(
        "unknown",
        "That T3 connection cannot be read right now; open the T3 thread reference to review it directly.",
        ids,
      );
    }

    let detail: ThreadReadView;
    try {
      const page: unknown = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "thread",
        input: { threadId },
      });
      const view = threadReadView(page);
      if (!view || view.thread.threadId !== threadId) {
        return result(
          "unknown",
          "That thread could not be verified; open the T3 thread reference to review it directly.",
          ids,
        );
      }
      detail = view;
    } catch {
      // No upstream text is ever surfaced: any read failure is evidence lost,
      // so the honest state is unknown with a handoff.
      return result(
        "unknown",
        "That thread could not be read right now; open the T3 thread reference to review it directly.",
        ids,
      );
    }
    if (detail.thread.projectId !== projectId) {
      return result(
        "unknown",
        "That thread belongs to a different project; open the T3 thread reference to review it directly.",
        ids,
      );
    }
    await assertOwnerCurrent();

    const waiting = detail.recentRuns.find((run) => classifyRunStatus(run.status) === "waiting") ?? null;
    if (waiting && typeof waiting.status === "string") {
      return result(
        "needs_attention",
        `An active run is waiting (status "${waiting.status.trim().toLowerCase().slice(0, 64)}"); act in T3. Pending-request evidence is unavailable over the external grant, so the T3 thread reference is the place to approve.`,
        ids,
      );
    }
    if (detail.recentRuns.some((run) => classifyRunStatus(run.status) === "active")) {
      return result("running", "An active run is making progress; no owner action is indicated.", ids);
    }
    if (detail.recentRuns.some((run) => classifyRunStatus(run.status) === "inflight_interrupt")) {
      return result("running", "An interrupt is in flight for the latest run; the run has not settled.", ids);
    }
    if (detail.recentRuns.length === 0) {
      return result("idle", "That thread has no runs; nothing is waiting.", ids);
    }
    if (detail.recentRuns.every((run) => classifyRunStatus(run.status) === "terminal")) {
      return result("idle", "Every observed run reached a terminal state; nothing is waiting.", ids);
    }
    // Runs exist but none carries a decidable status (all null/empty): the
    // available evidence cannot decide, and pending-request evidence is
    // unreachable over the external grant. Unknown with a handoff — never an
    // invented approval-response API.
    return result(
      "unknown",
      "That thread's run states carry no decidable signal and pending-request evidence is unavailable over the external grant; open the T3 thread reference to review it directly.",
      ids,
    );
  },
});
