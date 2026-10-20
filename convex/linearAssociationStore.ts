import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { requireCurrentOwnerGrant, requireOwner, type OwnerIdentity } from "./lib/auth";
import { syncErrorCode } from "./linearSyncStore";

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

/**
 * Bounded taxonomy of an association-recording refusal. The recording NEVER
 * crashes the launch path: a refusal is durably MARKED on the launch attempt
 * row (N6) so the operator queue can surface it, and the caller gets a typed
 * reason. `refusalMessage` carries the exact fixed sentence the public
 * `recordFromLaunch` action has always thrown, so its contract is unchanged.
 */
export const refusalCodeLiteral = v.union(
  v.literal("attempt_not_found"),
  v.literal("attempt_mismatch"),
  v.literal("attempt_not_accepted"),
  v.literal("no_correlation_key"),
  v.literal("target_project_mismatch"),
  v.literal("missing_mapping"),
  v.literal("already_bound"),
  v.literal("identity_drift"),
  v.literal("other"),
);
export type RefusalCode = Infer<typeof refusalCodeLiteral>;

/** The fixed operator-visible marker prefix on a launch attempt row (N6). */
export const RECORDING_FAILURE_NOTE_PREFIX = "association recording failed";

function refusalMessageFor(code: RefusalCode, detail: string | null): string {
  switch (code) {
    case "attempt_not_found":
      return "The launch attempt could not be found; no association was recorded.";
    case "attempt_mismatch":
      return detail ?? "The launch attempt does not match the claimed issue or thread; nothing was recorded.";
    case "attempt_not_accepted":
      return detail ?? "The launch attempt is not accepted; only accepted (acknowledged/reconciled) launches are associated.";
    case "no_correlation_key":
      return "The launch attempt has no correlation key; no association was recorded.";
    case "target_project_mismatch":
      return "The launch attempt targeted a different T3 project than the mapping; nothing was recorded.";
    case "missing_mapping":
      return "No enabled mapping for this Linear project and team; map it first.";
    case "already_bound":
      return detail ?? "The T3 thread is already associated with an issue; nothing was recorded.";
    case "identity_drift":
      return "The association already exists with a different stable identity; nothing was changed.";
    case "other":
      return "The launch attempt could not be associated; nothing was recorded.";
  }
}

function classifyRefusalMessage(message: string): RefusalCode {
  if (/different stable identity/.test(message)) return "identity_drift";
  if (/already associated with issue/.test(message)) return "already_bound";
  if (/could not be found/.test(message)) return "attempt_not_found";
  if (/only accepted \(acknowledged\/reconciled\)/.test(message)) return "attempt_not_accepted";
  if (/targeted a different T3 project/.test(message)) return "target_project_mismatch";
  if (/different Linear issue|different T3 thread/.test(message)) return "attempt_mismatch";
  if (/correlation key/.test(message)) return "no_correlation_key";
  return "other";
}

/** Classify one of the thrown refusal messages this module produces.
 * Only OUR OWN fixed sentences are matched — never upstream text. */

/** Durably mark a refused association recording on the launch attempt row (N6). */
async function markRecordingFailure(
  ctx: MutationCtx,
  attemptId: string,
  code: RefusalCode,
): Promise<void> {
  const row = await ctx.db
    .query("launchAttempts")
    .withIndex("by_attempt_id", (q) => q.eq("attemptId", attemptId))
    .first();
  if (!row) return; // nothing durable to mark
  await ctx.db.patch(row._id, {
    note: `${RECORDING_FAILURE_NOTE_PREFIX} (${code})`,
  });
}

/** Explicit marker writer for the tiny residual: if the recording call itself
 * crashed (environment failure), the launch path marks the attempt from the
 * outside. Never throws for a missing attempt. */
export const recordRecordingFailure = internalMutation({
  args: { attemptId: v.string(), code: refusalCodeLiteral },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markRecordingFailure(ctx, args.attemptId, args.code);
    return null;
  },
});

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
  /**
   * The T3 project the launch was bound to at reservation time. The caller
   * never chooses this: the mapping it names must match this recorded target,
   * or the association is refused (F2).
   */
  targetProjectId: v.union(v.string(), v.null()),
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
      targetProjectId: row.targetProjectId ?? null,
    };
  },
});

const internalLaunchReturns = v.object({
  associationId: v.union(v.id("linearIssueThreads"), v.null()),
  created: v.boolean(),
  /** Set when the recording was REFUSED; the marker note was then written. */
  refusal: v.union(refusalCodeLiteral, v.null()),
  /** The exact fixed refusal sentence; thrown by the public action layer. */
  message: v.optional(v.string()),
});

/**
 * The launch-path association recording, driven from the ALREADY-RESOLVED
 * owner identity (N8) — no public-action authentication involved. It performs
 * the SAME evidence checks as `recordFromLaunch` and, unlike it, NEVER throws
 * for a refusal: a refusal returns a typed code and durably MARKS the attempt
 * row (N6) so `openLedger` can surface the gap. Launch semantics are
 * untouched: the launch path swallows everything here.
 */
export const recordFromLaunchInternal = internalMutation({
  args: {
    ...ownerArgs,
    linearProjectId: v.string(),
    linearTeamId: v.string(),
    linearIssueId: v.string(),
    attemptId: v.string(),
    threadId: v.string(),
  },
  returns: internalLaunchReturns,
  handler: async (ctx, args): Promise<Infer<typeof internalLaunchReturns>> => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const refused = async (code: RefusalCode, message: string): Promise<Infer<typeof internalLaunchReturns>> => {
      await markRecordingFailure(ctx, args.attemptId, code);
      return { associationId: null, created: false, refusal: code, ...(message !== undefined ? { message } : {}) };
    };

    try {
      requiredId(args.linearProjectId, "The Linear project identity");
      requiredId(args.linearTeamId, "The Linear team identity");
      requiredId(args.linearIssueId, "The Linear issue identity");
      requiredId(args.attemptId, "The attempt identity");
      if (!isValidT3ThreadId(args.threadId)) {
        return await refused("attempt_mismatch", "The T3 thread identity is invalid");
      }

      // The enabled mapping supplies — and binds — both identity halves, in
      // the same order (and with the same fixed sentences) the public action
      // has always used.
      const mapping = await ctx.runQuery(internal.projectMappingsStore.resolveMappingForIssue, {
        subject: args.subject, ownerIssuer: args.ownerIssuer, revision: args.revision,
        linearProjectId: args.linearProjectId, linearTeamId: args.linearTeamId,
      });
      if (!mapping) {
        return await refused("missing_mapping",
          "No enabled mapping for this Linear project and team; map it first.");
      }

      // The launch evidence must already be durable. Read the attempt row and
      // require acceptance: acknowledged, or reconciled to exactly one thread.
      const evidence = await ctx.runQuery(internal.linearAssociationStore.launchEvidence, { attemptId: args.attemptId });
      if (evidence === null) {
        return await refused("attempt_not_found", refusalMessageFor("attempt_not_found", null));
      }
      if (evidence.issueKey !== args.linearIssueId) {
        return await refused("attempt_mismatch",
          "The launch attempt belongs to a different Linear issue; nothing was recorded.");
      }
      if (evidence.threadId !== args.threadId) {
        return await refused("attempt_mismatch",
          "The launch attempt belongs to a different T3 thread; nothing was recorded.");
      }
      if (evidence.state !== "acknowledged" && evidence.state !== "reconciled") {
        return await refused("attempt_not_accepted",
          `The launch attempt is ${evidence.state}; only accepted (acknowledged/reconciled) launches are associated.`);
      }
      if (evidence.correlationKey === null) {
        return await refused("no_correlation_key", refusalMessageFor("no_correlation_key", null));
      }
      if (evidence.targetProjectId === null || evidence.targetProjectId !== mapping.t3ProjectId) {
        return await refused("target_project_mismatch", refusalMessageFor("target_project_mismatch", null));
      }

      // The human-readable issue label comes from the durable attempt row when
      // it carries one; the issue id is the evidence fallback. Never a
      // caller-supplied label.
      const linearIssueIdentifier = evidence.issueIdentifier ?? args.linearIssueId;
      let ensured;
      try {
        // Same transaction as the refusal marker: a refused association is
        // durably observable without any second round trip (N6).
        ensured = await ensureAssociationHandler(ctx, {
          subject: args.subject, ownerIssuer: args.ownerIssuer, revision: args.revision,
          linearWorkspaceId: mapping.linearWorkspaceId,
          linearProjectId: mapping.linearProjectId,
          linearTeamId: mapping.linearTeamId,
          linearIssueId: args.linearIssueId,
          linearIssueIdentifier,
          t3ConnectionId: mapping.t3ConnectionId,
          t3EnvironmentId: mapping.t3EnvironmentId,
          t3ProjectId: mapping.t3ProjectId,
          t3ThreadId: args.threadId,
          attemptId: args.attemptId,
          correlationKey: evidence.correlationKey,
          at: Date.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/different stable identity|already associated with issue/.test(message)) {
          const code = classifyRefusalMessage(message);
          return await refused(code, message);
        }
        throw error;
      }
      return {
        associationId: ensured.associationId,
        created: ensured.created,
        refusal: null,
      };
    } catch (error) {
      // Identity/authorization failures are NOT refusals to record: they
      // propagate (the launch path swallows them, unchanged).
      throw error;
    }
  },
});

/**
 * Operator-queue visibility for refused recordings (N6): launch attempt rows
 * carrying the fixed marker note. `launchAttempts` has no owner column (EGA-681
 * design; every read is validated through its issue), and Helm is
 * single-owner by construction — the bounded scan is what `openLedger` lists.
 */
export const recordingFailureRows = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.object({
    attemptId: v.string(),
    issueKey: v.string(),
    issueIdentifier: v.union(v.string(), v.null()),
    attemptState: v.string(),
    note: v.string(),
  })),
  handler: async (ctx, args) => {
    const bound = Math.max(1, Math.min(args.limit, 200));
    const rows = await ctx.db.query("launchAttempts").take(1000);
    const failures: { attemptId: string; issueKey: string; issueIdentifier: string | null; attemptState: string; note: string }[] = [];
    for (const row of rows) {
      if (typeof row.note !== "string" || !row.note.startsWith(RECORDING_FAILURE_NOTE_PREFIX)) continue;
      failures.push({
        attemptId: row.attemptId,
        issueKey: row.issueKey,
        issueIdentifier: row.issueIdentifier ?? null,
        attemptState: row.state,
        note: row.note,
      });
      if (failures.length >= bound) break;
    }
    return failures;
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
  handler: async (ctx, args) => ensureAssociationHandler(ctx, args),
});

type EnsureAssociationHandlerArgs = {
  subject: string;
  ownerIssuer: string;
  revision: number;
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
  at: number;
  note?: string;
};

/**
 * The association creation body, shared by the exported mutation and the
 * launch-path internal recording (one transaction, no nested-mutation
 * surprise). Any drift or cross-issue binding throws; the internal recording
 * classifies and marks it, the mutation path lets it propagate.
 */
async function ensureAssociationHandler(
  ctx: MutationCtx,
  args: EnsureAssociationHandlerArgs,
): Promise<{
  associationId: import("./_generated/dataModel").Id<"linearIssueThreads">;
  ledgerId: import("./_generated/dataModel").Id<"linearSyncLedger">;
  created: boolean;
}> {
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
}

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

/**
 * Owner-scoped listing of every association for one Linear issue (oldest
 * first). When `linearProjectId`/`linearTeamId` are passed, the list is
 * additionally scoped to associations sharing that resolved identity, so a
 * sync resolved under one (project, team) can never touch rows bound to
 * another team or project on the same issue id (F1). Omitted by read paths
 * that display the full ledger regardless of team.
 */
export const associationsForIssue = internalQuery({
  args: {
    ...ownerArgs,
    linearIssueId: v.string(),
    linearProjectId: v.optional(v.string()),
    linearTeamId: v.optional(v.string()),
  },
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
    return rows
      .filter((row) =>
        (args.linearProjectId === undefined || row.linearProjectId === args.linearProjectId) &&
        (args.linearTeamId === undefined || row.linearTeamId === args.linearTeamId))
      .map(toView);
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
    lastErrorCode: syncErrorCode,
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
