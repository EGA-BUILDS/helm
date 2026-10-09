import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Durable launch attempts (EGA-677 task 5).
 *
 * The EGA-677 fault injection proved the dangerous case: T3 accepted a launch,
 * created the thread, and then the acknowledgment was lost before it reached the
 * caller. A dispatcher that treats that as "launch failed" and retries will
 * create a duplicate thread.
 *
 * Two rules encode the proven-safe behaviour:
 *
 *  1. An attempt row with a UNIQUE correlation key is written BEFORE dispatch.
 *     Reconciliation then has something unambiguous to match on. EGA-677 proved
 *     recovery only for a deliberately unique title; that limit is preserved here
 *     rather than papered over.
 *
 *  2. An ambiguous match NEVER triggers an automatic relaunch. `reconcileLaunch`
 *     only ever resolves 1 -> reconciled. Zero or many -> ambiguous, and the
 *     caller must stop and ask a human.
 *
 * No secret is stored here.
 */

export type AttemptState =
  | "prepared"
  | "dispatching"
  | "acknowledged"
  | "reconciled"
  | "ambiguous"
  | "abandoned";

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
 */
export const prepareLaunchAttempt = mutation({
  args: {
    issueKey: v.string(),
    attemptId: v.string(),
  },
  returns: v.object({
    attemptId: v.string(),
    correlationKey: v.string(),
    state: v.literal("prepared"),
  }),
  handler: async (ctx, args) => {
    // Refuse to reuse an attemptId: a duplicate id would corrupt correlation.
    const clash = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (clash) {
      throw new Error(`attemptId already exists: ${args.attemptId}`);
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
      correlationKey,
      state: "prepared" as const,
      threadId: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      matchCount: null,
    });
    void id;
    return { attemptId: args.attemptId, correlationKey, state: "prepared" as const };
  },
});

/** Mark that a dispatch was issued. The attempt is now not safe to blind-retry. */
export const markDispatching = mutation({
  args: { attemptId: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
    // Never move an acknowledged attempt backwards into dispatching.
    if (row.state === "acknowledged" || row.state === "reconciled") {
      throw new Error(`attempt already settled: ${row.state}`);
    }
    await ctx.db.patch(row._id, { state: "dispatching" as const, dispatchedAt: args.at });
  },
});

/** Record a successful acknowledgment. */
export const markAcknowledged = mutation({
  args: { attemptId: v.string(), threadId: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
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
 * Deliberately total: it records what was found and stops. It never launches.
 */
export const recordReconciliation = mutation({
  args: {
    attemptId: v.string(),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
  },
  returns: v.object({
    state: v.union(v.literal("reconciled"), v.literal("ambiguous")),
    /** True only when exactly one thread was found. */
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
    state: "reconciled" | "ambiguous";
    safeToProceed: boolean;
    relaunchAuthorized: false;
    matchCount: number;
    threadId: string | null;
  }> => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);

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
      relaunchAuthorized: false,
      matchCount: args.matchCount,
      threadId: exactlyOne ? args.threadId : row.threadId,
    };
  },
});

/** Explicit, human-initiated abandonment. Never automatic. */
export const abandonAttempt = mutation({
  args: { attemptId: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) throw new Error(`unknown attemptId: ${args.attemptId}`);
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
export const getCorrelationForReconciliation = query({
  args: { attemptId: v.string() },
  returns: v.union(v.null(), v.object({
    attemptId: v.string(),
    issueKey: v.string(),
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
      correlationKey: row.correlationKey,
      state: row.state,
      threadId: row.threadId,
      matchCount: row.matchCount,
      relaunchAuthorized: false as const,
    };
  },
});

/** Attempts that need a human. Drives the operator queue. */
export const listAmbiguousAttempts = query({
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
      .collect();
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