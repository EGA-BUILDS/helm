import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { requireCurrentOwnerGrant, requireOwner, type OwnerIdentity } from "./lib/auth";

/**
 * The canonical Linear issue <-> native T3 thread association store (EGA-762).
 *
 * EXACTLY ONE association table backs this module — `linearIssueThreads` in
 * `convex/schema.ts`. There is deliberately no second "native activity" store:
 * execution history lives in `launchAttempts` (referenced here by attemptId),
 * and this table adds only the durable identity binding between the two
 * sides. Identity is ids everywhere: Linear workspace / project / team /
 * issue, and T3 connection / environment / project / thread.
 *
 * Rules encoded here:
 *
 *  1. Association rows are recorded ONLY for launches that are ACCEPTED
 *     (`acknowledged`) or RECOVERED (`reconciled`) in `launchAttempts`. The
 *     attempt row — not the caller — is the evidence: its `threadId` and
 *     `issueKey` must match the request exactly.
 *
 *  2. Creation is idempotent on the (owner, issue, thread) pair. Retrying the
 *     same recording returns the existing row (`created: false`) and writes
 *     nothing. A thread can never be re-associated with a DIFFERENT issue once
 *     bound.
 *
 *  3. Multiple intentional threads per issue coexist. Every insert appends a
 *     row keyed by the full (owner, issue, thread) tuple; nothing here
 *     replaces or deletes an earlier association.
 *
 *  4. Every read and write is owner-scoped (`ownerSubject` / `ownerIssuer`
 *     with a live current-grant check, matching `projectMappingsStore`), and
 *     thread lookups additionally bind the T3 connection, so a caller on the
 *     wrong owner or the wrong connection can never read or adopt a row.
 */

const ownerArgs = { subject: v.string(), ownerIssuer: v.string(), revision: v.number() };

const MAX_ID_LENGTH = 1024;

const associationFields = v.object({
  linearWorkspaceId: v.string(),
  linearProjectId: v.string(),
  linearTeamId: v.string(),
  linearIssueId: v.string(),
  linearIssueIdentifier: v.string(),
  t3ConnectionId: v.id("t3Connections"),
  t3EnvironmentId: v.string(),
  t3ProjectId: v.string(),
  t3ThreadId: v.string(),
  attemptId: v.string(),
  correlationKey: v.string(),
});

const associationView = v.object({
  associationId: v.id("linearIssueThreads"),
  ...associationFields.fields,
  ownerSubject: v.string(),
  ownerIssuer: v.string(),
  createdAt: v.number(),
  note: v.optional(v.string()),
});

type AssociationRow = {
  _id: import("./_generated/dataModel").Id<"linearIssueThreads">;
  ownerSubject: string;
  ownerIssuer: string;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  t3ConnectionId: import("./_generated/dataModel").Id<"t3Connections">;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ThreadId: string;
  attemptId: string;
  correlationKey: string;
  createdAt: number;
  note?: string;
};

function toView(row: AssociationRow): Infer<typeof associationView> {
  return {
    associationId: row._id,
    linearWorkspaceId: row.linearWorkspaceId,
    linearProjectId: row.linearProjectId,
    linearTeamId: row.linearTeamId,
    linearIssueId: row.linearIssueId,
    linearIssueIdentifier: row.linearIssueIdentifier,
    t3ConnectionId: row.t3ConnectionId,
    t3EnvironmentId: row.t3EnvironmentId,
    t3ProjectId: row.t3ProjectId,
    t3ThreadId: row.t3ThreadId,
    attemptId: row.attemptId,
    correlationKey: row.correlationKey,
    ownerSubject: row.ownerSubject,
    ownerIssuer: row.ownerIssuer,
    createdAt: row.createdAt,
    ...(row.note === undefined ? {} : { note: row.note }),
  };
}

function requiredId(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function checkIdentityFields(args: {
  linearWorkspaceId: string;
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  t3EnvironmentId: string;
  t3ProjectId: string;
}): void {
  requiredId(args.linearWorkspaceId, "The Linear workspace identity");
  requiredId(args.linearProjectId, "The Linear project identity");
  requiredId(args.linearTeamId, "The Linear team identity");
  requiredId(args.linearIssueId, "The Linear issue identity");
  requiredId(args.linearIssueIdentifier, "The Linear issue identifier");
  requiredId(args.t3EnvironmentId, "The T3 environment identity");
  requiredId(args.t3ProjectId, "The T3 project identity");
}

export const ownerContext = internalQuery({
  args: {},
  returns: v.object({ subject: v.string(), issuer: v.string(), revision: v.number() }),
  handler: async (ctx): Promise<OwnerIdentity> => requireOwner(ctx),
});

/**
 * Read-only launch evidence from the shared `launchAttempts` table. The
 * association layer never writes attempts and never launches; it only reads
 * the durable record the launch path already committed, and refuses unless
 * that record proves an accepted thread.
 */
const launchEvidenceReturns = v.union(v.null(), v.object({
  issueKey: v.string(),
  issueIdentifier: v.union(v.string(), v.null()),
  threadId: v.union(v.string(), v.null()),
  state: v.string(),
  correlationKey: v.string(),
}));

export const launchEvidence = internalQuery({
  args: { attemptId: v.string() },
  returns: launchEvidenceReturns,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("launchAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId))
      .first();
    if (!row) return null;
    return {
      issueKey: row.issueKey,
      issueIdentifier: row.issueIdentifier ?? null,
      threadId: row.threadId,
      state: row.state,
      correlationKey: row.correlationKey,
    };
  },
});

/**
 * Idempotent creation of one association row plus its pending ledger row.
 *
 * The full stable-identity projection of an existing row must match the
 * request exactly; any drift is a conflict and is refused rather than
 * overwritten. Creation is a pure append: sibling associations for the same
 * issue are never touched.
 */
export const ensureAssociation = internalMutation({
  args: {
    ...ownerArgs,
    ...associationFields.fields,
    at: v.number(),
    note: v.optional(v.string()),
  },
  returns: v.object({
    associationId: v.id("linearIssueThreads"),
    ledgerId: v.id("linearSyncLedger"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    checkIdentityFields(args);
    if (args.t3ThreadId !== args.t3ThreadId.trim() || args.t3ThreadId.length > 40) {
      throw new Error("The T3 thread identity is invalid");
    }
    if (!isValidT3ThreadId(args.t3ThreadId)) {
      throw new Error("The T3 thread identity is invalid");
    }

    // Idempotency lookup: the exact (owner, issue, thread) pair, by index.
    const matched = await ctx.db
      .query("linearIssueThreads")
      .withIndex("by_owner_issue_thread", (q) =>
        q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer)
          .eq("linearIssueId", args.linearIssueId).eq("t3ThreadId", args.t3ThreadId))
      .take(2);
    if (matched.length > 1) throw new Error("association identity is ambiguous");
    if (matched[0]) {
      const row = matched[0]!;
      const drift =
        row.linearWorkspaceId !== args.linearWorkspaceId ||
        row.linearProjectId !== args.linearProjectId ||
        row.linearTeamId !== args.linearTeamId ||
        row.linearIssueIdentifier !== args.linearIssueIdentifier ||
        row.t3ConnectionId !== args.t3ConnectionId ||
        row.t3EnvironmentId !== args.t3EnvironmentId ||
        row.t3ProjectId !== args.t3ProjectId ||
        row.attemptId !== args.attemptId ||
        row.correlationKey !== args.correlationKey;
      if (drift) {
        throw new Error(
          "The association already exists with a different stable identity; nothing was changed.",
        );
      }
      const ledgerId = await ensureLedgerRow(ctx, row._id, row, args.subject, args.ownerIssuer, args.revision, args.at);
      return { associationId: row._id, ledgerId, created: false };
    }

    // The thread must never be re-associated with a different issue.
    const threadBound = await ctx.db
      .query("linearIssueThreads")
      .withIndex("by_owner_thread", (q) =>
        q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer)
          .eq("t3ThreadId", args.t3ThreadId))
      .take(2);
    if (threadBound.length > 0) {
      const bound = threadBound.find((row) =>
        row.ownerSubject === args.subject && row.ownerIssuer === args.ownerIssuer);
      if (bound && bound.linearIssueId !== args.linearIssueId) {
        throw new Error(
          `The T3 thread is already associated with issue ${bound.linearIssueId}; a thread is bound to exactly one issue.`,
        );
      }
    }

    const associationId: import("./_generated/dataModel").Id<"linearIssueThreads"> =
      await ctx.db.insert("linearIssueThreads", {
        ownerSubject: args.subject,
        ownerIssuer: args.ownerIssuer,
        ownerRevision: args.revision,
        linearWorkspaceId: args.linearWorkspaceId,
        linearProjectId: args.linearProjectId,
        linearTeamId: args.linearTeamId,
        linearIssueId: args.linearIssueId,
        linearIssueIdentifier: args.linearIssueIdentifier,
        t3ConnectionId: args.t3ConnectionId,
        t3EnvironmentId: args.t3EnvironmentId,
        t3ProjectId: args.t3ProjectId,
        t3ThreadId: args.t3ThreadId,
        attemptId: args.attemptId,
        correlationKey: args.correlationKey,
        createdAt: args.at,
        ...(args.note === undefined ? {} : { note: args.note }),
      });
    const ledgerId = await ensureLedgerRow(
      ctx,
      associationId,
      {
        linearWorkspaceId: args.linearWorkspaceId,
        linearIssueId: args.linearIssueId,
        linearIssueIdentifier: args.linearIssueIdentifier,
        linearTeamId: args.linearTeamId,
      },
      args.subject,
      args.ownerIssuer,
      args.revision,
      args.at,
    );
    return { associationId, ledgerId, created: true };
  },
});

async function ensureLedgerRow(
  ctx: MutationCtx,
  associationId: import("./_generated/dataModel").Id<"linearIssueThreads">,
  identity: {
    linearWorkspaceId: string;
    linearIssueId: string;
    linearIssueIdentifier: string;
    linearTeamId: string;
  },
  subject: string,
  issuer: string,
  revision: number,
  now: number,
): Promise<import("./_generated/dataModel").Id<"linearSyncLedger">> {
  const existing = await ctx.db
    .query("linearSyncLedger")
    .withIndex("by_association", (q) => q.eq("associationId", associationId))
    .take(2);
  if (existing.length > 1) throw new Error("sync ledger identity is ambiguous");
  if (existing[0]) return existing[0]!._id;
  return await ctx.db.insert("linearSyncLedger", {
    ownerSubject: subject,
    ownerIssuer: issuer,
    ownerRevision: revision,
    associationId,
    linearWorkspaceId: identity.linearWorkspaceId,
    linearIssueId: identity.linearIssueId,
    linearIssueIdentifier: identity.linearIssueIdentifier,
    linearTeamId: identity.linearTeamId,
    targetStateId: null,
    targetStateName: null,
    state: "pending" as const,
    attemptCount: 0,
    lastErrorCode: null,
    observedStateId: null,
    observedStateName: null,
    observedStateType: null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Owner- and connection-bound lookup of the association behind a T3 thread. */
export const associationForThread = internalQuery({
  args: { ...ownerArgs, t3ConnectionId: v.id("t3Connections"), t3ThreadId: v.string() },
  returns: v.union(associationView, v.null()),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearIssueThreads")
      .withIndex("by_owner_thread", (q) =>
        q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer)
          .eq("t3ThreadId", args.t3ThreadId))
      .take(2);
    const row = rows.find((entry) =>
      entry.ownerSubject === args.subject && entry.ownerIssuer === args.ownerIssuer &&
      entry.t3ConnectionId === args.t3ConnectionId);
    return row ? toView(row) : null;
  },
});

/** Owner-scoped listing of every association for one Linear issue (oldest first). */
export const associationsForIssue = internalQuery({
  args: { ...ownerArgs, linearIssueId: v.string() },
  returns: v.array(associationView),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearIssueThreads")
      .withIndex("by_owner_issue_thread", (q) =>
        q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer)
          .eq("linearIssueId", args.linearIssueId))
      .take(101);
    if (rows.length > 100) throw new Error("association inventory exceeds the supported limit");
    return rows.map(toView);
  },
});

/** The sync ledger row for one association; null when none exists. */
export const ledgerForAssociation = internalQuery({
  args: { ...ownerArgs, associationId: v.id("linearIssueThreads") },
  returns: v.union(v.null(), v.object({
    ledgerId: v.id("linearSyncLedger"),
    associationId: v.id("linearIssueThreads"),
    state: v.string(),
    attemptCount: v.number(),
    targetStateId: v.union(v.string(), v.null()),
    targetStateName: v.union(v.string(), v.null()),
    lastErrorCode: v.union(
      v.literal("rate_limited"), v.literal("timed_out"), v.literal("graph_ql_errors"),
      v.literal("conflicted"), v.literal("authorization_required"),
      v.literal("read_failed"), v.literal("unreachable"), v.null(),
    ),
    observedStateId: v.union(v.string(), v.null()),
    observedStateName: v.union(v.string(), v.null()),
    observedStateType: v.union(v.string(), v.null()),
    note: v.optional(v.string()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearSyncLedger")
      .withIndex("by_association", (q) => q.eq("associationId", args.associationId))
      .take(2);
    if (rows.length > 1) throw new Error("sync ledger identity is ambiguous");
    const row = rows[0];
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) return null;
    return {
      ledgerId: row._id,
      associationId: row.associationId,
      state: row.state,
      attemptCount: row.attemptCount,
      targetStateId: row.targetStateId ?? null,
      targetStateName: row.targetStateName ?? null,
      lastErrorCode: row.lastErrorCode ?? null,
      observedStateId: row.observedStateId ?? null,
      observedStateName: row.observedStateName ?? null,
      observedStateType: row.observedStateType ?? null,
      ...(row.note === undefined ? {} : { note: row.note }),
    };
  },
});
