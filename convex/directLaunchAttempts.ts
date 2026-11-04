import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  DIRECT_ABANDONED_RETRY,
  DIRECT_ATTEMPT_UNKNOWN,
  DIRECT_NAMESPACE_CHANGED,
  DIRECT_PAYLOAD_MISMATCH,
  DIRECT_TARGET_MISMATCH,
} from "./lib/directLaunchErrors";

/**
 * EGA-812 — durable ledger for DIRECT project launches.
 *
 * A direct launch starts a native T3 thread from a T3 project without a Linear
 * issue. It reuses the hard-won EGA-677 rules but NOT the issue-bound table:
 *
 *  1. The row is written BEFORE dispatch. `attemptId` is the owner's stable
 *     intent id, so a double click, a concurrent tab or a reload presents the
 *     same id and the stored row — never process memory — decides what
 *     happens. Same id + same canonical payload reuses the row; same id with a
 *     different payload or target is refused. Convex mutations are
 *     serializable, so the read-then-insert here is atomic.
 *
 *  2. `markDispatching` is the single irreversible transition and is the only
 *     claim on a dispatch. Concurrent callers race on it; exactly one wins.
 *     Every terminal state change is monotonic: a settled attempt can never be
 *     reopened and an ambiguous one can never be coerced back to "not sent".
 *
 *  3. There is deliberately NO project-wide lock. Two DIFFERENT confirmed
 *     intents in the same project are independent rows and both may dispatch;
 *     an unresolved attempt only ever blocks its own intent id.
 *
 *  4. The credential namespace (connection id + credential version + owner
 *     grant revision) is part of the recorded identity. `clientRequestId` is a
 *     native retry key only inside one namespace, so a changed namespace is
 *     reported, never silently re-dispatched.
 *
 * Every export here is internal. The public, owner-gated surface lives in
 * `convex/directLaunch.ts`.
 */

/** Lowercase SHA-256 hex digest binding an intent id to its payload. */
const PAYLOAD_HASH_PATTERN = /^[a-f0-9]{64}$/u;
/** Stable intent id: bounded opaque charset, same rule as native attempt ids. */
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Bound for the reload lookup. Per-project history stays tiny. */
const RECOVERY_SCAN_LIMIT = 50;

/** States that carry a confirmed result. Once entered, never left. */
const SETTLED: ReadonlySet<string> = new Set(["acknowledged", "reconciled"]);

/** States after which a direct launch may have reached T3. */
const POSSIBLY_DISPATCHED: ReadonlySet<string> = new Set(["dispatching", "ambiguous"]);

function randomSuffix(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export const directAttemptReturns = v.object({
  attemptId: v.string(),
  correlationKey: v.string(),
  clientRequestId: v.string(),
  state: v.string(),
  reused: v.boolean(),
  threadId: v.union(v.string(), v.null()),
  connectionId: v.id("t3Connections"),
  credentialVersion: v.number(),
  environmentId: v.string(),
  projectId: v.string(),
  ownerRevision: v.number(),
  /** True when a retry's credential namespace no longer matches the record. */
  namespaceChanged: v.boolean(),
});

type DirectAttemptView = {
  attemptId: string;
  correlationKey: string;
  clientRequestId: string;
  state: string;
  reused: boolean;
  threadId: string | null;
  connectionId: Doc<"directLaunchAttempts">["connectionId"];
  credentialVersion: number;
  environmentId: string;
  projectId: string;
  ownerRevision: number;
  namespaceChanged: boolean;
};

function viewOf(
  row: Doc<"directLaunchAttempts">,
  args: { credentialVersion: number; ownerRevision: number },
  reused: boolean,
): DirectAttemptView {
  return {
    attemptId: row.attemptId,
    correlationKey: row.correlationKey,
    clientRequestId: row.clientRequestId,
    state: row.state,
    reused,
    threadId: row.threadId,
    connectionId: row.connectionId,
    credentialVersion: row.credentialVersion,
    environmentId: row.environmentId,
    projectId: row.projectId,
    ownerRevision: row.ownerRevision,
    namespaceChanged:
      row.credentialVersion !== args.credentialVersion || row.ownerRevision !== args.ownerRevision,
  };
}

/**
 * Atomically reserve one direct-launch intent BEFORE any dispatch.
 *
 * Owner isolation comes from the caller: the action resolves `ownerSubject` /
 * `ownerIssuer` from the verified grant, never from request input. The
 * (owner, attemptId) index is the idempotency key.
 */
export const reserveDirectLaunch = internalMutation({
  args: {
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    connectionId: v.id("t3Connections"),
    credentialVersion: v.number(),
    environmentId: v.string(),
    projectId: v.string(),
    attemptId: v.string(),
    payloadHash: v.string(),
  },
  returns: directAttemptReturns,
  handler: async (ctx, args): Promise<DirectAttemptView> => {
    if (!ATTEMPT_ID_PATTERN.test(args.attemptId)) {
      throw new Error("invalid direct launch intent id");
    }
    if (!PAYLOAD_HASH_PATTERN.test(args.payloadHash)) {
      throw new Error("payloadHash must be a lowercase SHA-256 hex digest");
    }

    const existing = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();

    if (existing) {
      // The intent id is bound to ONE canonical payload. A changed prompt,
      // model, base ref or branch is not a retry; it must not ride the
      // reservation.
      if (existing.payloadHash !== args.payloadHash) throw new Error(DIRECT_PAYLOAD_MISMATCH);
      // The target is part of the payload, but compare it explicitly too: the
      // durable identity must never be reinterpreted against a new target even
      // if a future payload format stops covering one of these fields.
      if (
        existing.connectionId !== args.connectionId ||
        existing.environmentId !== args.environmentId ||
        existing.projectId !== args.projectId
      ) {
        throw new Error(DIRECT_TARGET_MISMATCH);
      }
      return viewOf(existing, args, true);
    }

    // Mint the two native-visible markers at reservation time so they are
    // durable before any dispatch. Random suffixes plus unique indexes make
    // correlation unambiguous by construction.
    let correlationKey = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `[helm:direct:${randomSuffix(12)}]`;
      const dupe = await ctx.db
        .query("directLaunchAttempts")
        .withIndex("by_correlation_key", (q) => q.eq("correlationKey", candidate))
        .first();
      if (!dupe) {
        correlationKey = candidate;
        break;
      }
    }
    if (correlationKey === "") throw new Error("correlation key collision");

    let clientRequestId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `helm-direct-${randomSuffix(24)}`;
      const dupe = await ctx.db
        .query("directLaunchAttempts")
        .withIndex("by_client_request_id", (q) => q.eq("clientRequestId", candidate))
        .first();
      if (!dupe) {
        clientRequestId = candidate;
        break;
      }
    }
    if (clientRequestId === "") throw new Error("client request id collision");

    await ctx.db.insert("directLaunchAttempts", {
      kind: "direct_project" as const,
      ownerSubject: args.ownerSubject,
      ownerIssuer: args.ownerIssuer,
      ownerRevision: args.ownerRevision,
      connectionId: args.connectionId,
      credentialVersion: args.credentialVersion,
      environmentId: args.environmentId,
      projectId: args.projectId,
      attemptId: args.attemptId,
      payloadHash: args.payloadHash,
      clientRequestId,
      correlationKey,
      state: "prepared" as const,
      threadId: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      matchCount: null,
    });

    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    if (!row) throw new Error("direct launch reservation was not persisted");
    return viewOf(row, args, false);
  },
});

/**
 * The one irreversible dispatch claim. `prepared -> dispatching` only.
 *
 * Returns false when another invocation already claimed the dispatch (or the
 * attempt is no longer prepared). Throws when the credential namespace changed
 * between reservation and this claim: the native retry key belongs to the old
 * namespace, so the call must not be made under the new one.
 */
export const markDirectDispatching = internalMutation({
  args: {
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    attemptId: v.string(),
    credentialVersion: v.number(),
    ownerRevision: v.number(),
    at: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    if (!row) throw new Error(`unknown direct launch intent: ${args.attemptId}`);
    if (row.state === "dispatching") return false;
    if (row.state !== "prepared") return false;
    if (row.credentialVersion !== args.credentialVersion || row.ownerRevision !== args.ownerRevision) {
      throw new Error(DIRECT_NAMESPACE_CHANGED);
    }
    await ctx.db.patch(row._id, {
      state: "dispatching" as const,
      dispatchedAt: args.at,
    });
    return true;
  },
});

/**
 * Record a confirmed acknowledgement. Monotonic: a settled attempt keeps its
 * thread (same thread = no-op, different thread = refused conflict), and a
 * late acknowledgement of an ambiguous attempt resolves it.
 */
export const markDirectAcknowledged = internalMutation({
  args: {
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    attemptId: v.string(),
    threadId: v.string(),
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    if (!row) throw new Error(DIRECT_ATTEMPT_UNKNOWN);
    if (SETTLED.has(row.state)) {
      if (row.threadId === args.threadId) return;
      throw new Error(
        `direct launch intent ${args.attemptId} is settled on thread ${row.threadId}; refusing to re-acknowledge onto thread ${args.threadId}`,
      );
    }
    // An acknowledgement is only evidence for a dispatch that was actually
    // claimed. A prepared attempt was provably never sent.
    if (!POSSIBLY_DISPATCHED.has(row.state)) {
      throw new Error(
        `direct launch intent ${args.attemptId} is ${row.state}; it cannot be acknowledged`,
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
 * Record a bounded reconciliation observation.
 *
 * Deliberately total and monotonic: it records what was seen and stops. One
 * unique match settles an unresolved attempt; zero, many, or a bounded search
 * that could not complete leave it ambiguous. It never launches and never
 * authorizes a relaunch.
 */
export const recordDirectReconciliation = internalMutation({
  args: {
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    attemptId: v.string(),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
    note: v.optional(v.string()),
  },
  returns: v.object({
    state: v.string(),
    safeToProceed: v.boolean(),
    relaunchAuthorized: v.literal(false),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
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
    note: string | null;
  }> => {
    if (!Number.isSafeInteger(args.matchCount) || args.matchCount < 0) {
      throw new Error("invalid reconciliation match count");
    }
    if ((args.matchCount === 1) !== (args.threadId !== null)) {
      throw new Error("reconciliation count and thread identifier disagree");
    }
    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    if (!row) throw new Error(DIRECT_ATTEMPT_UNKNOWN);

    if (SETTLED.has(row.state)) {
      const note =
        args.matchCount === 1
          ? args.threadId === row.threadId
            ? `late reconciliation confirmed the acknowledged thread ${row.threadId}`
            : `conflicting observation: reconciliation found thread ${args.threadId}; the acknowledged thread ${row.threadId} is preserved`
          : args.matchCount === 0
            ? "late reconciliation found no matches; the acknowledged result is preserved"
            : `late reconciliation found ${args.matchCount} matches; the acknowledged result is preserved`;
      await ctx.db.patch(row._id, { matchCount: args.matchCount, note });
      return {
        state: row.state,
        safeToProceed: true,
        relaunchAuthorized: false as const,
        matchCount: args.matchCount,
        threadId: row.threadId,
        note,
      };
    }

    if (row.state === "abandoned") {
      throw new Error(DIRECT_ABANDONED_RETRY);
    }

    // A prepared attempt was provably never dispatched; reconciliation must
    // not invent an ambiguous "maybe sent" state for it.
    if (row.state === "prepared") {
      return {
        state: row.state,
        safeToProceed: false,
        relaunchAuthorized: false as const,
        matchCount: args.matchCount,
        threadId: row.threadId,
        note: row.note ?? null,
      };
    }

    const exactlyOne = args.matchCount === 1 && args.threadId !== null;
    const state: "reconciled" | "ambiguous" = exactlyOne ? "reconciled" : "ambiguous";

    await ctx.db.patch(row._id, {
      state,
      matchCount: args.matchCount,
      threadId: exactlyOne ? args.threadId : row.threadId,
      ...(args.note ? { note: args.note } : {}),
    });

    return {
      state,
      safeToProceed: exactlyOne,
      relaunchAuthorized: false as const,
      matchCount: args.matchCount,
      threadId: exactlyOne ? args.threadId : row.threadId,
      note: args.note ?? row.note ?? null,
    };
  },
});

/** Explicit, human-initiated abandonment. Never automatic. */
export const abandonDirectAttempt = internalMutation({
  args: { ownerSubject: v.string(), ownerIssuer: v.string(), attemptId: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    if (!row) throw new Error(DIRECT_ATTEMPT_UNKNOWN);
    if (SETTLED.has(row.state)) {
      throw new Error(`direct launch intent already settled: ${row.state}`);
    }
    if (row.state === "abandoned") return;
    await ctx.db.patch(row._id, {
      state: "abandoned" as const,
      note: args.note ?? "abandoned by operator",
    });
  },
});

export const directAttemptViewReturns = v.union(
  v.null(),
  v.object({
    attemptId: v.string(),
    correlationKey: v.string(),
    clientRequestId: v.string(),
    state: v.string(),
    threadId: v.union(v.string(), v.null()),
    connectionId: v.id("t3Connections"),
    credentialVersion: v.number(),
    environmentId: v.string(),
    projectId: v.string(),
    ownerRevision: v.number(),
    payloadHash: v.string(),
    dispatchedAt: v.union(v.number(), v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
    matchCount: v.union(v.number(), v.null()),
    note: v.union(v.string(), v.null()),
  }),
);

export type DirectAttemptViewResult = {
  attemptId: string;
  correlationKey: string;
  clientRequestId: string;
  state: string;
  threadId: string | null;
  connectionId: Doc<"directLaunchAttempts">["connectionId"];
  credentialVersion: number;
  environmentId: string;
  projectId: string;
  ownerRevision: number;
  payloadHash: string;
  dispatchedAt: number | null;
  acknowledgedAt: number | null;
  matchCount: number | null;
  note: string | null;
};

export function toDirectAttemptView(row: Doc<"directLaunchAttempts">): DirectAttemptViewResult {
  return {
    attemptId: row.attemptId,
    correlationKey: row.correlationKey,
    clientRequestId: row.clientRequestId,
    state: row.state,
    threadId: row.threadId,
    connectionId: row.connectionId,
    credentialVersion: row.credentialVersion,
    environmentId: row.environmentId,
    projectId: row.projectId,
    ownerRevision: row.ownerRevision,
    payloadHash: row.payloadHash,
    dispatchedAt: row.dispatchedAt,
    acknowledgedAt: row.acknowledgedAt,
    matchCount: row.matchCount,
    note: row.note ?? null,
  };
}

/** Read one intent, scoped to its owner. Powers reload/recovery. */
export const getDirectAttempt = internalQuery({
  args: { ownerSubject: v.string(), ownerIssuer: v.string(), attemptId: v.string() },
  returns: directAttemptViewReturns,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_attempt", (q) =>
        q.eq("ownerSubject", args.ownerSubject).eq("ownerIssuer", args.ownerIssuer).eq("attemptId", args.attemptId),
      )
      .first();
    return row ? toDirectAttemptView(row) : null;
  },
});

/**
 * Newest attempt for one owner project IN one environment. Read-only reload
 * path: it returns the SAME durable state the launch wrote, not browser
 * memory.
 *
 * The lookup is environment-scoped because a project id is only unique inside
 * one T3 environment. When a connection filter is supplied, a bounded
 * newest-first scan finds the newest row for that connection without ever
 * hiding a newer row behind older ones.
 */
export const latestDirectAttemptForProject = internalQuery({
  args: {
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    environmentId: v.string(),
    projectId: v.string(),
    connectionId: v.optional(v.id("t3Connections")),
  },
  returns: directAttemptViewReturns,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("directLaunchAttempts")
      .withIndex("by_owner_environment_project", (q) =>
        q
          .eq("ownerSubject", args.ownerSubject)
          .eq("ownerIssuer", args.ownerIssuer)
          .eq("environmentId", args.environmentId)
          .eq("projectId", args.projectId),
      )
      .order("desc")
      .take(RECOVERY_SCAN_LIMIT);
    const newest = args.connectionId
      ? rows.find((row) => row.connectionId === args.connectionId) ?? null
      : rows[0] ?? null;
    return newest ? toDirectAttemptView(newest) : null;
  },
});
