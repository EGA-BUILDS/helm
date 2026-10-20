import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { requireCurrentOwnerGrant } from "./lib/auth";

/**
 * Internal sync ledger state machine (EGA-762).
 *
 * All writes for the `linearSyncLedger` table live here — the actions in
 * `linearSync.ts` only decide and call. Nothing in this file touches the
 * network, T3, or the launch path: a Linear sync failure can never author a
 * relaunch, and these mutations never write any table other than
 * `linearSyncLedger` (with owner rechecks from lib/auth).
 *
 * Ledger states: `pending` (recorded, not yet synced), `synced` (post-mutation
 * re-read observed the target state), `retryable` (Linear refused or the
 * outcome stayed unclear; a deliberate later `syncIssue` call retries),
 * `conflicted` (Done / Canceled / moved / externally changed; recorded, never
 * overwritten), `authorization_required` (grant missing, expired, revoked).
 */
export const syncErrorCode = v.union(
  v.literal("rate_limited"),
  v.literal("timed_out"),
  v.literal("graph_ql_errors"),
  v.literal("conflicted"),
  v.literal("authorization_required"),
  v.literal("read_failed"),
  v.literal("unreachable"),
  v.null(),
);

export const ledgerStateLiteral = v.union(
  v.literal("pending"), v.literal("synced"),
  v.literal("conflicted"), v.literal("retryable"), v.literal("authorization_required"),
);

/**
 * Open (or refresh) the ledger rows before a sync attempt, so the attempt is
 * durable even if the process dies mid-action: attemptCount is incremented
 * and an absent row is created as `pending` in the same nested mutation.
 * Every association must already be owner-verified; foreign ids are refused.
 */
export const beginSyncAttempt = internalMutation({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
    at: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    // All rows of an issue share one attempt counter (they were created in
    // the same sync); `attemptCount` is the shared count after this attempt.
    let attemptCount = 0;
    for (const associationId of args.associationIds) {
      const association = await ctx.db.get(associationId);
      if (!association || association.ownerSubject !== args.subject || association.ownerIssuer !== args.ownerIssuer) {
        throw new Error("An association for this issue belongs to another owner; sync refused.");
      }
      const existing = await ctx.db
        .query("linearSyncLedger")
        .withIndex("by_association", (q) => q.eq("associationId", associationId))
        .take(2);
      if (existing.length > 1) throw new Error("sync ledger identity is ambiguous");
      const row = existing[0];
      if (!row) {
        attemptCount = 1;
        await ctx.db.insert("linearSyncLedger", {
          ownerSubject: args.subject,
          ownerIssuer: args.ownerIssuer,
          ownerRevision: args.revision,
          associationId,
          linearWorkspaceId: association.linearWorkspaceId,
          linearIssueId: association.linearIssueId,
          linearIssueIdentifier: association.linearIssueIdentifier,
          linearTeamId: association.linearTeamId,
          targetStateId: null,
          targetStateName: null,
          state: "pending" as const,
          attemptCount,
          lastErrorCode: null,
          observedStateId: null,
          observedStateName: null,
          observedStateType: null,
          createdAt: args.at,
          updatedAt: args.at,
        });
      } else {
        attemptCount = row.attemptCount + 1;
        await ctx.db.patch(row._id, { attemptCount, updatedAt: args.at });
      }
    }
    return attemptCount;
  },
});

/**
 * Record one ledger outcome for every association of the issue. Each record
 * carries the evidence that justified it (target state, observed state, fixed
 * error code, bounded note). Synced is reached ONLY through observed truth —
 * this mutation itself trusts nothing: `linearSync.syncIssue` decides.
 */
export const recordSyncOutcome = internalMutation({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
    state: ledgerStateLiteral,
    errorCode: syncErrorCode,
    targetStateId: v.union(v.string(), v.null()),
    targetStateName: v.union(v.string(), v.null()),
    observedStateId: v.union(v.string(), v.null()),
    observedStateName: v.union(v.string(), v.null()),
    observedStateType: v.union(v.string(), v.null()),
    note: v.optional(v.string()),
    at: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const boundedNote = args.note === undefined ? undefined : args.note.slice(0, 500);
    let touched = 0;
    for (const associationId of args.associationIds) {
      const association = await ctx.db.get(associationId);
      if (!association || association.ownerSubject !== args.subject || association.ownerIssuer !== args.ownerIssuer) {
        throw new Error("An association for this issue belongs to another owner; sync refused.");
      }
      const existing = await ctx.db
        .query("linearSyncLedger")
        .withIndex("by_association", (q) => q.eq("associationId", associationId))
        .take(2);
      if (existing.length > 1) throw new Error("sync ledger identity is ambiguous");
      const row = existing[0];
      const patch = {
        state: args.state,
        lastErrorCode: args.errorCode ?? null,
        targetStateId: args.targetStateId ?? row?.targetStateId ?? null,
        targetStateName: args.targetStateName ?? row?.targetStateName ?? null,
        observedStateId: args.observedStateId ?? null,
        observedStateName: args.observedStateName ?? null,
        observedStateType: args.observedStateType ?? null,
        updatedAt: args.at,
        ...(boundedNote === undefined ? {} : { note: boundedNote }),
      };
      if (!row) {
        await ctx.db.insert("linearSyncLedger", {
          ownerSubject: args.subject,
          ownerIssuer: args.ownerIssuer,
          ownerRevision: args.revision,
          associationId,
          linearWorkspaceId: association.linearWorkspaceId,
          linearIssueId: association.linearIssueId,
          linearIssueIdentifier: association.linearIssueIdentifier,
          linearTeamId: association.linearTeamId,
          attemptCount: 1,
          createdAt: args.at,
          ...patch,
        });
      } else {
        await ctx.db.patch(row._id, patch);
      }
      touched += 1;
    }
    return touched;
  },
});
