import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { isValidT3ThreadId } from "./lib/threadIdentity";

/**
 * Durable launch attempts (EGA-677 task 5, hardened).
 *
 * EVERY export is internal. These functions were briefly public, which let any
 * client that could reach the deployment forge attempts and acknowledgements.
 * Dispatch is the only caller, and it is itself an internalAction.
 *
 * The EGA-677 fault injection proved the dangerous case: T3 accepted a launch,
 * created the thread, and then the acknowledgment was lost before it reached the
 * caller. A dispatcher that treats that as "launch failed" and retries will
 * create a duplicate thread.
 *
 * Three rules encode the proven-safe behaviour:
 *
 *  1. (M-2) An attempt row with a UNIQUE attemptId is written BEFORE dispatch.
 *     The attemptId doubles as the durable request identifier: a retry of the
 *     same logical launch presents the same attemptId, and the stored row — not
 *     a process-local map — decides what happens. The same attemptId with an
 *     identical canonical payload reuses the existing attempt; the same
 *     attemptId with a DIFFERENT payload is rejected. While an attempt for an
 *     issue is unresolved, no new attempt for that issue can be reserved at
 *     all. Convex mutations are serializable, so the read-then-insert sequence
 *     here is atomic across concurrent callers: exactly one reservation wins,
 *     and the loser observes the winner's row.
 *
 *  2. (L-3) Transitions are monotonic. A settled attempt (acknowledged or
 *     reconciled) can never regress to an uncertain state because of a late,
 *     stale, missing or contradictory observation. Conflicting observations are
 *     recorded in the note while the settled state, thread identity,
 *     acknowledgment evidence and attempt history are preserved.
 *
 *  3. An ambiguous match NEVER triggers an automatic relaunch. Reconciliation
 *     only ever resolves 1 -> reconciled. Zero or many -> ambiguous, and the
 *     caller must stop and ask a human.
 *
 * No secret is stored here.
 */

/** Attempt states, in knowledge order: later states carry strictly more evidence. */
export type AttemptState =
  | "prepared"
  | "dispatching"
  | "acknowledged"
  | "reconciled"
  | "ambiguous"
  | "abandoned";

/** States that do not yet say whether the launch happened. */
const UNRESOLVED = ["prepared", "dispatching", "ambiguous"] as const satisfies readonly AttemptState[];

/** States that carry a confirmed result. Once entered, never left. */
const SETTLED: ReadonlySet<string> = new Set(["acknowledged", "reconciled"]);

/** Short, collision-resistant suffix for the correlation key. */
function randomSuffix(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Prepare an attempt. MUST be called before dispatch so the correlation key is
 * durable even if the dispatch call's response is lost.
 *
 * Idempotent on attemptId: the same attemptId with the same payloadHash returns
 * the existing attempt (reused) so a retry can never create a second remote
 * launch; the same attemptId with a different payload is rejected; and a NEW
 * attemptId is refused while any earlier attempt for the issue is unresolved —
 * that launch must be reconciled (or explicitly abandoned) first, never
 * silently replaced.
 */
export const prepareLaunchAttempt = internalMutation({
  args: {
    issueKey: v.string(),
    targetProjectId: v.optional(v.string()),
    /** Stable request identifier across retries; doubles as the attempt handle. */
    attemptId: v.string(),
    /** SHA-256 over the canonical dispatch payload; binds the id to its meaning. */
    payloadHash: v.string(),
  },
  returns: v.object({
    attemptId: v.string(),
    correlationKey: v.string(),
    state: v.string(),
    /** True when an existing attempt was reused instead of created. */
    reused: v.boolean(),
    threadId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();

    if (existing) {
      // The attemptId is bound to ONE canonical payload. Presenting it again
      // with a different payload is not a retry — it is a different launch
      // trying to ride an existing reservation — and must never reuse it.
      if (existing.payloadHash !== args.payloadHash) {
        throw new Error(
          `attemptId ${args.attemptId} was already reserved with a different payload; use a new attemptId`,
        );
      }
      if (existing.targetProjectId !== args.targetProjectId) {
        throw new Error("attemptId was already reserved for a different target project");
      }
      return {
        attemptId: existing.attemptId,
        correlationKey: existing.correlationKey,
        state: existing.state,
        reused: true as const,
        threadId: existing.threadId,
      };
    }

    // One unresolved attempt per issue. A different attemptId must not slip a
    // second launch past an attempt whose outcome is still unknown: duplicate
    // request ids are handled above, competing ids are refused here.
    // Query each unresolved state by the complete (issueKey, state) index
    // range. `.first()` is safe here because existence, not enumeration, is
    // the invariant; no result window can hide an older matching row. These
    // indexed range reads and the insert share this mutation transaction, so
    // competing reservations conflict/retry under Convex serializable OCC.
    let unresolved = null;
    for (const state of UNRESOLVED) {
      const row = await ctx.db
        .query("launchAttempts")
        .withIndex("by_issue_key_and_state", (q) =>
          q.eq("issueKey", args.issueKey).eq("state", state),
        )
        .first();
      if (row) {
        unresolved = row;
        break;
      }
    }
    if (unresolved) {
      throw new Error(
        `issue ${args.issueKey} already has an unresolved attempt (${unresolved.attemptId}, state ${unresolved.state}); reconcile or abandon it before launching again`,
      );
    }

    // The correlation key must be unique across all attempts, or reconciliation
    // becomes ambiguous by construction.
    const correlationKey = `[helm:${args.issueKey}:${randomSuffix()}]`;
    const dupe = await ctx.db
      .query("launchAttempts")
      .withIndex("by_correlation_key", (q) => q.eq("correlationKey", correlationKey))
      .first();
    if (dupe) throw new Error("correlation key collision");

    const id = await ctx.db.insert("launchAttempts", {
      attemptId: args.attemptId,
      issueKey: args.issueKey,
      ...(args.targetProjectId ? { targetProjectId: args.targetProjectId } : {}),
      payloadHash: args.payloadHash,
      correlationKey,
      state: "prepared" as const,
      threadId: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      matchCount: null,
    });
    void id;
    return {
      attemptId: args.attemptId,
      correlationKey,
      state: "prepared" as const,
      reused: false as const,
      threadId: null,
    };
  },
});

/**
 * Mark that a dispatch was issued. The attempt is now not safe to blind-retry.
 *
 * Monotonic (L-3): only a `prepared` attempt may enter `dispatching`. A settled
 * attempt can never be reopened, an ambiguous attempt must be reconciled
 * first. A second concurrent claimant sees `dispatching` and returns false,
 * allowing the action to stop without treating the race as an error.
 */
export const markDispatching = internalMutation({
  args: { attemptId: v.string(), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
    if (row.state === "dispatching") return false;
    if (row.state !== "prepared") {
      if (SETTLED.has(row.state)) {
        throw new Error(`attempt already settled: ${row.state}`);
      }
      throw new Error(
        `attempt ${args.attemptId} is ${row.state}; it cannot enter dispatching (reconcile an ambiguous attempt, or reserve a new attemptId after abandonment)`,
      );
    }
    await ctx.db.patch(row._id, { state: "dispatching" as const, dispatchedAt: args.at });
    return true;
  },
});

/**
 * Record a successful acknowledgment.
 *
 * Monotonic (L-3): allowed from `prepared`, `dispatching` and `ambiguous` (a
 * late acknowledgment resolves an ambiguous attempt). A settled attempt with
 * the SAME thread id is an idempotent no-op; with a DIFFERENT thread id it is
 * a conflict — two threads claiming one attempt is exactly the ambiguity this
 * table exists to prevent — and is refused rather than absorbed.
 */
export const markAcknowledged = internalMutation({
  args: { attemptId: v.string(), threadId: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isValidT3ThreadId(args.threadId)) throw new Error("invalid thread identifier");
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
    if (SETTLED.has(row.state)) {
      if (row.threadId === args.threadId) return;
      throw new Error(
        `attempt ${args.attemptId} is settled on thread ${row.threadId}; refusing to re-acknowledge onto thread ${args.threadId}`,
      );
    }
    await ctx.db.patch(row._id, {
      state: "acknowledged" as const,
      threadId: args.threadId,
      acknowledgedAt: args.at,
    });
  },
});

/**
 * Reconciliation verdict for an attempt whose acknowledgment was lost.
 *
 * Deliberately total: it records what was found and stops. It never launches,
 * and it is MONOTONIC (L-3): for a settled attempt (acknowledged or reconciled)
 * an observation can only confirm, never replace — a late, stale or
 * contradictory observation is recorded in the note and matchCount while the
 * settled state, thread identity and acknowledgment evidence are preserved.
 * For an unresolved attempt, exactly one match reconciles it; zero or many
 * leave it ambiguous.
 */
export const recordReconciliation = internalMutation({
  args: {
    attemptId: v.string(),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
  },
  returns: v.object({
    state: v.string(),
    /** True only when the attempt carries one confirmed thread. */
    safeToProceed: v.boolean(),
    /** Always false: reconciliation never authorizes a relaunch. */
    relaunchAuthorized: v.literal(false),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    state: string;
    safeToProceed: boolean;
    relaunchAuthorized: false;
    matchCount: number;
    threadId: string | null;
  }> => {
    if (!Number.isSafeInteger(args.matchCount) || args.matchCount < 0) {
      throw new Error("invalid reconciliation match count");
    }
    if ((args.matchCount === 1) !== (args.threadId !== null)) {
      throw new Error("reconciliation count and thread identifier disagree");
    }
    if (args.threadId !== null && !isValidT3ThreadId(args.threadId)) {
      throw new Error("invalid thread identifier");
    }
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);

    // Settled attempts keep their confirmed result no matter what a late
    // observation says. The observation is recorded; the state is not.
    if (SETTLED.has(row.state)) {
      let note: string;
      if (args.matchCount === 1 && args.threadId !== null) {
        if (args.threadId === row.threadId) {
          note = `late reconciliation confirmed the acknowledged thread ${row.threadId}`;
        } else {
          note = `conflicting observation: reconciliation found thread ${args.threadId}; the acknowledged thread ${row.threadId} is preserved`;
        }
      } else if (args.matchCount === 0) {
        note = "late reconciliation found no matches; the acknowledged result is preserved";
      } else {
        note = `late reconciliation found ${args.matchCount} matches; the acknowledged result is preserved`;
      }
      await ctx.db.patch(row._id, { matchCount: args.matchCount, note });
      return {
        state: row.state,
        safeToProceed: true,
        relaunchAuthorized: false as const,
        matchCount: args.matchCount,
        threadId: row.threadId,
      };
    }

    // Exactly one match is the only self-service case. Zero means the launch may
    // not have happened; many means we cannot tell which is ours. Both are human
    // decisions, and neither may trigger a relaunch.
    const exactlyOne = args.matchCount === 1 && args.threadId !== null;
    const state: "reconciled" | "ambiguous" = exactlyOne ? "reconciled" : "ambiguous";

    await ctx.db.patch(row._id, {
      state,
      matchCount: args.matchCount,
      threadId: exactlyOne ? args.threadId : row.threadId,
    });

    return {
      state,
      safeToProceed: exactlyOne,
      relaunchAuthorized: false as const,
      matchCount: args.matchCount,
      threadId: exactlyOne ? args.threadId : row.threadId,
    };
  },
});

/** Explicit, human-initiated abandonment. Never automatic. */
export const abandonAttempt = internalMutation({
  args: { attemptId: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
    // A settled attempt has a confirmed result; there is nothing to abandon and
    // discarding it would destroy the evidence. Re-abandoning is a no-op.
    if (SETTLED.has(row.state)) {
      throw new Error(`attempt already settled: ${row.state}`);
    }
    if (row.state === "abandoned") return;
    await ctx.db.patch(row._id, {
      state: "abandoned" as const,
      note: args.note ?? "abandoned by operator",
    });
  },
});

/**
 * Correlation lookup for a lost acknowledgment. Returns the unique marker to
 * search T3 with, plus whether the state is safe to act on automatically.
 */
export const getCorrelationForReconciliation = internalQuery({
  args: { attemptId: v.string() },
  returns: v.union(v.null(), v.object({
    attemptId: v.string(),
    issueKey: v.string(),
    targetProjectId: v.union(v.string(), v.null()),
    correlationKey: v.string(),
    state: v.string(),
    threadId: v.union(v.string(), v.null()),
    matchCount: v.union(v.number(), v.null()),
    relaunchAuthorized: v.literal(false),
  })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) return null;
    return {
      attemptId: row.attemptId,
      issueKey: row.issueKey,
      targetProjectId: row.targetProjectId ?? null,
      correlationKey: row.correlationKey,
      state: row.state,
      threadId: row.threadId,
      matchCount: row.matchCount,
      relaunchAuthorized: false as const,
    };
  },
});

/** Attempts that need a human. Drives the operator queue. */
export const listAmbiguousAttempts = internalQuery({
  args: {},
  returns: v.array(v.object({
    attemptId: v.string(),
    issueKey: v.string(),
    correlationKey: v.string(),
    state: v.string(),
    matchCount: v.union(v.number(), v.null()),
    threadId: v.union(v.string(), v.null()),
  })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("launchAttempts")
      .withIndex("by_state", (q) => q.eq("state", "ambiguous"))
      .take(100);
    return rows.map((r) => ({
      attemptId: r.attemptId,
      issueKey: r.issueKey,
      correlationKey: r.correlationKey,
      state: r.state,
      matchCount: r.matchCount,
      threadId: r.threadId,
    }));
  },
});
