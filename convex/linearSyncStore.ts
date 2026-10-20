import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
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
 * Ledger states: `pending` (recorded, not yet synced), `syncing` (an attempt
 * is in flight — the shared contention marker the two automatic drivers claim
 * through), `synced` (post-mutation re-read observed the target state),
 * `retryable` (Linear refused or the outcome stayed unclear; re-driven by
 * the launch trigger and the periodic retry driver with bounded backoff, or
 * by an explicit `syncIssue` call), `conflicted` (Done / Canceled / moved /
 * human state change / externally changed / misconfigured or refused write;
 * recorded, never overwritten), `authorization_required` (grant missing,
 * expired, revoked).
 *
 * TWO DRIVERS, ONE LEDGER: the launch path schedules an immediate sync when
 * it records a NEW association, and the periodic driver
 * (`convex/crons.ts` -> `linearSync.driveRetryable`) re-drives the rows it
 * OWNS — `pending` and `retryable` — with bounded backoff. Neither driver
 * ever launches native work. `conflicted` / `authorization_required` rows are
 * never driven automatically: they need an explicit `syncIssue` call.
 */
export const syncErrorCode = v.union(
  v.literal("rate_limited"),
  v.literal("timed_out"),
  v.literal("graph_ql_errors"),
  v.literal("conflicted"),
  v.literal("authorization_required"),
  v.literal("read_failed"),
  v.literal("unreachable"),
  /** Linear refused the state write outright (data.success === false). */
  v.literal("write_rejected"),
  /** The mapped started state is stale: a configuration stop, never retried. */
  v.literal("misconfigured"),
  v.null(),
);

export const ledgerStateLiteral = v.union(
  v.literal("pending"), v.literal("syncing"), v.literal("synced"),
  v.literal("conflicted"), v.literal("retryable"), v.literal("authorization_required"),
);

/**
 * The states a sync OUTCOME can be recorded in. `pending` is the state a
 * fresh association starts in and `syncing` is the in-flight marker; neither
 * is ever an outcome, so neither can be written by `recordSyncOutcome`.
 */
export const ledgerOutcomeLiteral = v.union(
  v.literal("synced"),
  v.literal("conflicted"),
  v.literal("retryable"),
  v.literal("authorization_required"),
);

/**
 * The stable Linear identity every ledger write must agree with. A sync is
 * scoped to associations matching the resolved (project, team); a row whose
 * own `linearProjectId`/`linearTeamId` disagrees with the recorded target
 * state would make the ledger lie, so every write REFUSES a mismatch.
 */
const syncIdentityArgs = {
  linearProjectId: v.string(),
  linearTeamId: v.string(),
} as const;

function requireIdentityMatch(
  association: { linearProjectId: string; linearTeamId: string },
  args: { linearProjectId: string; linearTeamId: string },
): void {
  if (association.linearProjectId !== args.linearProjectId || association.linearTeamId !== args.linearTeamId) {
    throw new Error(
      "An association for this issue is bound to a different Linear project or team than the sync's resolved identity; sync refused.",
    );
  }
}

/**
 * CLAIM the ledger rows of one issue for one attempt — the SHARED CONTENTION
 * POINT between the two automatic drivers (the launch trigger and the
 * periodic driver).
 *
 * The claim is a state transition to `syncing`, performed inside ONE
 * transaction, over EVERY association of the issue. That is what makes it a
 * contention point rather than a hint:
 *
 *   - a driver that finds a FRESH `syncing` row is refused: the row belongs
 *     to another driver right now, so this driver writes nothing at all;
 *   - the row leaves `pending` / `retryable` while the attempt runs, so the
 *     other driver's index read does not even return it;
 *   - the transition also bumps `attemptCount`, so an attempt is ledgered
 *     BEFORE any network call and a crash never loses the fact that it
 *     happened;
 *   - a CRASHED attempt leaves the row `syncing`; once the claim lease
 *     expires the periodic driver reclaims it (it is the driver's own
 *     `syncing` state, reclaimed exactly like a `retryable` row).
 *
 * Every association must already be owner-verified and must carry the SAME
 * (project, team) identity the sync was resolved under; foreign ids or a
 * cross-team row are refused rather than patched.
 */
export const claimSyncAttempt = internalMutation({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
    ...syncIdentityArgs,
    at: v.number(),
    /** How long a claim stays fresh; a stale claim may be reclaimed. */
    leaseMs: v.number(),
  },
  returns: v.object({
    claimed: v.boolean(),
    attemptCount: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
    /** Why the claim was refused; null when it was granted. */
    reason: v.union(v.literal("in_flight"), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const associations: Array<Doc<"linearIssueThreads">> = [];
    const rows: Array<Doc<"linearSyncLedger"> | null> = [];
    for (const associationId of args.associationIds) {
      const association = await ctx.db.get(associationId);
      if (!association || association.ownerSubject !== args.subject || association.ownerIssuer !== args.ownerIssuer) {
        throw new Error("An association for this issue belongs to another owner; sync refused.");
      }
      requireIdentityMatch(association, args);
      const existing = await ctx.db
        .query("linearSyncLedger")
        .withIndex("by_association", (q) => q.eq("associationId", associationId))
        .take(2);
      if (existing.length > 1) throw new Error("sync ledger identity is ambiguous");
      associations.push(association);
      rows.push(existing[0] ?? null);
    }
    // A FRESH in-flight marker means another driver owns this issue RIGHT
    // NOW. The whole issue is refused: a partial claim would still write the
    // same Linear issue twice.
    for (const row of rows) {
      if (row && row.state === "syncing" && args.at - row.updatedAt < args.leaseMs) {
        return {
          claimed: false,
          attemptCount: row.attemptCount,
          associationIds: [],
          reason: "in_flight" as const,
        };
      }
    }
    // All rows of an issue share one attempt counter (they were created in
    // the same sync); `attemptCount` is the shared count after this attempt.
    let attemptCount = 0;
    for (const [index, associationId] of args.associationIds.entries()) {
      const row = rows[index] ?? null;
      const association = associations[index]!;
      attemptCount = row ? row.attemptCount + 1 : 1;
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
          targetStateId: null,
          targetStateName: null,
          state: "syncing" as const,
          attemptCount,
          lastErrorCode: null,
          observedStateId: null,
          observedStateName: null,
          observedStateType: null,
          createdAt: args.at,
          updatedAt: args.at,
        });
      } else {
        await ctx.db.patch(row._id, { state: "syncing" as const, attemptCount, updatedAt: args.at });
      }
    }
    return {
      claimed: true,
      attemptCount,
      associationIds: args.associationIds,
      reason: null,
    };
  },
});

/**
 * The ledger rows of ONE issue's associations, in one read. The automatic
 * drivers use it to decide, BEFORE claiming anything, whether the issue is
 * already `synced` (nothing to do — no write at all) or still inside its
 * backoff window (too early to re-drive).
 */
export const ledgerRowsForAssociations = internalQuery({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
  },
  returns: v.array(v.object({
    associationId: v.id("linearIssueThreads"),
    state: v.string(),
    attemptCount: v.number(),
    updatedAt: v.number(),
    lastErrorCode: syncErrorCode,
    targetStateId: v.union(v.string(), v.null()),
    targetStateName: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const out: Array<{
      associationId: Id<"linearIssueThreads">;
      state: string;
      attemptCount: number;
      updatedAt: number;
      lastErrorCode: Infer<typeof syncErrorCode>;
      targetStateId: string | null;
      targetStateName: string | null;
    }> = [];
    for (const associationId of args.associationIds) {
      const rows = await ctx.db
        .query("linearSyncLedger")
        .withIndex("by_association", (q) => q.eq("associationId", associationId))
        .take(2);
      if (rows.length > 1) throw new Error("sync ledger identity is ambiguous");
      const row = rows[0];
      if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) continue;
      out.push({
        associationId,
        state: row.state,
        attemptCount: row.attemptCount,
        updatedAt: row.updatedAt,
        lastErrorCode: row.lastErrorCode ?? null,
        targetStateId: row.targetStateId ?? null,
        targetStateName: row.targetStateName ?? null,
      });
    }
    return out;
  },
});

/**
 * Read each ledger row's LAST OBSERVED Linear state before this attempt
 * records anything. F6 uses it as the baseline for human-intent detection:
 * the issue was observed at `observedStateId` by an earlier sync, so a later
 * read in a different started state means someone moved it since.
 */
export const ledgerBaseline = internalQuery({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
  },
  returns: v.array(v.object({
    associationId: v.id("linearIssueThreads"),
    observedStateId: v.union(v.string(), v.null()),
    observedStateName: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const out: {
      associationId: import("./_generated/dataModel").Id<"linearIssueThreads">;
      observedStateId: string | null;
      observedStateName: string | null;
    }[] = [];
    for (const associationId of args.associationIds) {
      const rows = await ctx.db
        .query("linearSyncLedger")
        .withIndex("by_association", (q) => q.eq("associationId", associationId))
        .take(2);
      if (rows.length > 1) throw new Error("sync ledger identity is ambiguous");
      const row = rows[0];
      if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) continue;
      out.push({
        associationId,
        observedStateId: row.observedStateId ?? null,
        observedStateName: row.observedStateName ?? null,
      });
    }
    return out;
  },
});

/**
 * The `by_state` index read for the operator work queue: ledger rows in one
 * open state (never `synced`), owner-scoped WITHOUT a table scan. This is the
 * query behind `linearSync.openLedger`. Listing only — nothing here retries,
 * schedules, or launches.
 */
export const openLedgerRows = internalQuery({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    state: ledgerStateLiteral,
    limit: v.number(),
  },
  returns: v.array(v.object({
    ledgerId: v.id("linearSyncLedger"),
    associationId: v.id("linearIssueThreads"),
    linearIssueId: v.string(),
    linearIssueIdentifier: v.string(),
    linearTeamId: v.string(),
    state: v.string(),
    attemptCount: v.number(),
    targetStateId: v.union(v.string(), v.null()),
    targetStateName: v.union(v.string(), v.null()),
    lastErrorCode: syncErrorCode,
    observedStateId: v.union(v.string(), v.null()),
    observedStateName: v.union(v.string(), v.null()),
    note: v.optional(v.string()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const bound = Math.max(1, Math.min(args.limit, 500));
    const rows = await ctx.db
      .query("linearSyncLedger")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .take(bound * 2 + 10);
    const out: Array<{
      ledgerId: import("./_generated/dataModel").Id<"linearSyncLedger">;
      associationId: import("./_generated/dataModel").Id<"linearIssueThreads">;
      linearIssueId: string;
      linearIssueIdentifier: string;
      linearTeamId: string;
      state: string;
      attemptCount: number;
      targetStateId: string | null;
      targetStateName: string | null;
      lastErrorCode: Infer<typeof syncErrorCode>;
      observedStateId: string | null;
      observedStateName: string | null;
      note?: string;
    }> = [];
    for (const row of rows) {
      if (row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) continue;
      out.push({
        ledgerId: row._id,
        associationId: row.associationId,
        linearIssueId: row.linearIssueId,
        linearIssueIdentifier: row.linearIssueIdentifier,
        linearTeamId: row.linearTeamId,
        state: row.state,
        attemptCount: row.attemptCount,
        targetStateId: row.targetStateId ?? null,
        targetStateName: row.targetStateName ?? null,
        lastErrorCode: row.lastErrorCode ?? null,
        observedStateId: row.observedStateId ?? null,
        observedStateName: row.observedStateName ?? null,
        ...(row.note === undefined ? {} : { note: row.note }),
      });
      if (out.length >= bound) break;
    }
    return out;
  },
});

/**
 * Record one ledger outcome for every association of the sync's identity.
 * Each record carries the evidence that justified it (target state, observed
 * state, fixed error code, bounded note). Synced is reached ONLY through
 * observed truth — this mutation itself trusts nothing: `linearSync.syncIssue`
 * decides. A row whose own (project, team) identity disagrees with the sync's
 * resolved identity is refused: a row's team must NEVER disagree with the
 * target state recorded for it (F1).
 *
 * `holdObserved` (N1): a human-intent conflict must NOT advance the row's
 * OBSERVED state to the human's new state — advancing it would renew the
 * baseline and make the next sync overwrite the deliberate move. With
 * `holdObserved`, the previously observed state stays (evidence moves to the
 * note), so the human-intent verdict is STICKY: every later sync keeps
 * refusing until the issue itself returns to the recorded baseline state.
 */
export const recordSyncOutcome = internalMutation({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    associationIds: v.array(v.id("linearIssueThreads")),
    ...syncIdentityArgs,
    state: ledgerOutcomeLiteral,
    errorCode: syncErrorCode,
    targetStateId: v.union(v.string(), v.null()),
    targetStateName: v.union(v.string(), v.null()),
    observedStateId: v.union(v.string(), v.null()),
    observedStateName: v.union(v.string(), v.null()),
    observedStateType: v.union(v.string(), v.null()),
    holdObserved: v.optional(v.boolean()),
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
      requireIdentityMatch(association, args);
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
        updatedAt: args.at,
        ...(boundedNote === undefined ? {} : { note: boundedNote }),
        // Human-intent conflicts hold the previously observed state (N1):
        // the baseline the guard consults must not be advanced to the
        // state a human deliberately moved the issue to.
        ...(args.holdObserved === true ? {} : {
          observedStateId: args.observedStateId ?? null,
          observedStateName: args.observedStateName ?? null,
          observedStateType: args.observedStateType ?? null,
        }),
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
          // A first-ever record with `holdObserved` has no previous baseline
          // to hold — the observed truth stays unrecorded (null).
          observedStateId: args.holdObserved === true ? null : args.observedStateId ?? null,
          observedStateName: args.holdObserved === true ? null : args.observedStateName ?? null,
          observedStateType: args.holdObserved === true ? null : args.observedStateType ?? null,
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

/**
 * The driver's fair-queue read: ONE state of the ledger, across all owners,
 * ordered by `(state, updatedAt)` through the `by_state_updated` index and
 * walked with a cursor.
 *
 * Why the cursor and the compound order matter: a plain `take(n)` on a
 * single-field index returns the same rows in creation order forever, so the
 * oldest rows monopolise every batch and later rows starve. Ordering by
 * `updatedAt` (which every attempt stamps) rotates the queue, and the cursor
 * lets one driver run walk deeper into the state instead of re-reading the
 * same head.
 *
 * `pending` and `retryable` are the states the driver OWNS. `syncing` is
 * returned too, but only so the driver can RECLAIM a row whose claim lease
 * expired (a crashed attempt); a fresh `syncing` row belongs to the driver
 * that is working on it right now.
 */
export const driverRows = internalQuery({
  args: {
    state: v.union(v.literal("pending"), v.literal("retryable"), v.literal("syncing")),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    rows: v.array(v.object({
      ledgerId: v.id("linearSyncLedger"),
      associationId: v.id("linearIssueThreads"),
      ownerSubject: v.string(),
      ownerIssuer: v.string(),
      ownerRevision: v.number(),
      state: v.string(),
      attemptCount: v.number(),
      updatedAt: v.number(),
      lastErrorCode: syncErrorCode,
    })),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("linearSyncLedger")
      .withIndex("by_state_updated", (q) => q.eq("state", args.state))
      .paginate(args.paginationOpts);
    const rows: Array<{
      ledgerId: Id<"linearSyncLedger">;
      associationId: Id<"linearIssueThreads">;
      ownerSubject: string;
      ownerIssuer: string;
      ownerRevision: number;
      state: string;
      attemptCount: number;
      updatedAt: number;
      lastErrorCode: Infer<typeof syncErrorCode>;
    }> = [];
    for (const row of result.page) {
      rows.push({
        ledgerId: row._id,
        associationId: row.associationId,
        ownerSubject: row.ownerSubject,
        ownerIssuer: row.ownerIssuer,
        ownerRevision: row.ownerRevision,
        state: row.state,
        attemptCount: row.attemptCount,
        updatedAt: row.updatedAt,
        lastErrorCode: row.lastErrorCode ?? null,
      });
    }
    return {
      rows,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
