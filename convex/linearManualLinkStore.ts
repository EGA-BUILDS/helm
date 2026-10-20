import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { requireCurrentOwnerGrant, requireOwner, type OwnerIdentity } from "./lib/auth";

/**
 * Manual Linear issue <-> native T3 thread association (EGA-763).
 *
 * This module reuses the ONE canonical `linearIssueThreads` table and its
 * indexes (`by_owner_issue_thread`, `by_owner_thread`). It adds no second
 * association table and no second native-activity store. The launch-derived
 * path (`linearAssociationStore.recordFromLaunchInternal`) remains the only
 * path that binds an association to a launch attempt; a manually linked thread
 * has NO launch attempt row, NO correlation key, and NO attempt id — its
 * `attemptId` and `correlationKey` are stored as empty strings and its `note`
 * carries "manual link" (or the operator's note) so the two kinds are always
 * distinguishable in storage and in the operator queue. Manual linking never
 * writes `launchAttempts` (except the pre-existing recording-failure marker
 * path, which is unrelated), never updates Linear state, and never touches Git.
 *
 * Rules encoded here:
 *
 *  1. One primary issue per thread. A thread already bound to an issue can
 *     only move to a different issue through an explicit, confirmed
 *     reassignment that names the association it believes it is changing.
 *  2. Multiple threads per issue coexist: a manual link appends a row keyed
 *     by the full (owner, issue, thread) tuple and never displaces a sibling.
 *  3. Unlink and reassignment require explicit confirmation; an accidental
 *     click (confirm !== true) is refused before any write.
 *  4. Reassignment is optimistic-concurrency checked: the caller supplies
 *     the association id it believes it is changing; a concurrent competing
 *     reassignment makes the loser fail with a specific conflict instead of
 *     last-write-wins.
 *  5. Exact validation: owner grant, T3 connection, environment, project and
 *     the Linear issue's (workspace, project, team) mapping must all resolve
 *     to durable rows; any mismatch is refused with a specific reason.
 *  6. Historic launch evidence is preserved: manual linking never rewrites or
 *     deletes a `launchAttempts` row. A manually linked thread simply has no
 *     launch attempt.
 */

const ownerArgs = { subject: v.string(), ownerIssuer: v.string(), revision: v.number() };

const MAX_ID_LENGTH = 1024;

function requiredId(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export const ownerContext = internalQuery({
  args: {},
  returns: v.object({ subject: v.string(), issuer: v.string(), revision: v.number() }),
  handler: async (ctx): Promise<OwnerIdentity> => requireOwner(ctx),
});

const linkArgs = {
  ...ownerArgs,
  // Linear side (and aliases)
  linearWorkspaceId: v.optional(v.string()),
  linearProjectId: v.optional(v.string()),
  linearTeamId: v.optional(v.string()),
  linearIssueId: v.optional(v.string()),
  linearIssueIdentifier: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  teamId: v.optional(v.string()),
  issueId: v.optional(v.string()),
  issueIdentifier: v.optional(v.string()),
  // T3 side (and aliases)
  t3ConnectionId: v.optional(v.union(v.id("t3Connections"), v.string())),
  t3EnvironmentId: v.optional(v.string()),
  t3ProjectId: v.optional(v.string()),
  t3ThreadId: v.optional(v.string()),
  connectionId: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  // Mapping selector
  mappingId: v.optional(v.id("linearProjectMappings")),
  linearProjectMappingId: v.optional(v.id("linearProjectMappings")),
  // Control
  confirm: v.optional(v.boolean()),
  confirmed: v.optional(v.boolean()),
  confirmLaunchEvidenceLoss: v.optional(v.boolean()),
  expectedAssociationId: v.optional(v.string()),
  expectedAssociation: v.optional(v.string()),
  currentAssociationId: v.optional(v.string()),
  fromAssociationId: v.optional(v.string()),
  associationId: v.optional(v.string()),
  note: v.optional(v.string()),
};

const linkArgsValidator = v.object(linkArgs);
type LinkArgs = Infer<typeof linkArgsValidator>;

function norm(args: LinkArgs) {
  const linearProjectId = (args.linearProjectId ?? args.projectId ?? "").trim();
  const linearTeamId = (args.linearTeamId ?? args.teamId ?? "").trim();
  const linearIssueId = (args.linearIssueId ?? args.issueId ?? "").trim();
  const t3ThreadIdRaw = (args.t3ThreadId ?? args.threadId ?? "").trim();
  if (!isValidT3ThreadId(t3ThreadIdRaw)) {
    throw new Error("The T3 thread identity is invalid");
  }
  const t3ThreadId = t3ThreadIdRaw;
  const t3ConnectionIdArg = args.t3ConnectionId ?? args.connectionId;
  const t3EnvironmentIdArg = (args.t3EnvironmentId ?? args.environmentId ?? "").trim();
  const t3ProjectIdArg = (args.t3ProjectId ?? "").trim();
  const linearWorkspaceIdArg = (args.linearWorkspaceId ?? args.workspaceId ?? "").trim();
  const linearIssueIdentifier = (args.linearIssueIdentifier ?? args.issueIdentifier ?? linearIssueId).trim() || linearIssueId;
  const mappingIdArg = args.mappingId ?? args.linearProjectMappingId;
  const confirm = args.confirm === true || args.confirmed === true;
  const expectedAssociationId =
    args.expectedAssociationId ?? args.expectedAssociation ?? args.currentAssociationId ?? args.fromAssociationId;
  return {
    linearProjectId, linearTeamId, linearIssueId, linearIssueIdentifier,
    t3ThreadId, t3ConnectionIdArg, t3EnvironmentIdArg, t3ProjectIdArg,
    linearWorkspaceIdArg, mappingIdArg, confirm, expectedAssociationId,
    confirmLaunchEvidenceLoss: args.confirmLaunchEvidenceLoss === true,
    note: args.note,
    associationIdArg: args.associationId,
  };
}

async function resolveMapping(ctx: MutationCtx, subject: string, issuer: string, revision: number, args: ReturnType<typeof norm>) {
  const owner = { subject, issuer, revision };
  await requireCurrentOwnerGrant(ctx, owner);
  let mapping: Doc<"linearProjectMappings"> | null = null;
  if (args.mappingIdArg) {
    const row = await ctx.db.get(args.mappingIdArg);
    if (!row || row.ownerSubject !== subject || row.ownerIssuer !== issuer) {
      throw new Error("Project mapping is unavailable");
    }
    if (!row.enabled) {
      throw new Error("Project mapping is disabled");
    }
    mapping = row;
  } else {
    const rows = await ctx.db
      .query("linearProjectMappings")
      .withIndex("by_owner_project_team", (q) =>
        q.eq("ownerSubject", subject).eq("ownerIssuer", issuer)
          .eq("linearProjectId", args.linearProjectId).eq("linearTeamId", args.linearTeamId))
      .take(3);
    const enabled = rows.filter((row) => row.enabled);
    if (enabled.length === 0) {
      throw new Error("No enabled mapping for this Linear project and team; map it first.");
    }
    if (enabled.length > 1) {
      throw new Error("Project mapping identity is ambiguous");
    }
    mapping = enabled[0];
  }
  // Exact validation against the durable mapping.
  if (args.linearWorkspaceIdArg && args.linearWorkspaceIdArg !== mapping.linearWorkspaceId) {
    throw new Error("Linear workspace does not match the durable project mapping");
  }
  if (mapping.linearProjectId !== args.linearProjectId) {
    throw new Error("Linear project does not match the durable project mapping");
  }
  if (mapping.linearTeamId !== args.linearTeamId) {
    throw new Error("Linear team does not match the durable project mapping");
  }
  // T3 side exact validation.
  if (args.t3ConnectionIdArg !== undefined && String(args.t3ConnectionIdArg) !== String(mapping.t3ConnectionId)) {
    throw new Error("T3 connection does not match the durable project mapping");
  }
  if (args.t3EnvironmentIdArg && args.t3EnvironmentIdArg !== mapping.t3EnvironmentId) {
    throw new Error("T3 environment does not match the durable project mapping");
  }
  if (args.t3ProjectIdArg && args.t3ProjectIdArg !== mapping.t3ProjectId) {
    throw new Error("T3 project does not match the durable project mapping");
  }
  // Connection durable row.
  const connection = await ctx.db.get(mapping.t3ConnectionId);
  if (!connection || connection.ownerSubject !== subject || connection.ownerIssuer !== issuer) {
    throw new Error("T3 connection is unavailable");
  }
  if (connection.status === "disconnected") {
    throw new Error("T3 connection is disconnected");
  }
  if (connection.environmentId !== mapping.t3EnvironmentId) {
    throw new Error("T3 environment identity changed; reconnect to confirm the endpoint");
  }
  if (connection.status !== "connected") {
    throw new Error("T3 connection is not connected");
  }
  return mapping;
}

async function currentAssociationForThread(ctx: MutationCtx, subject: string, issuer: string, t3ThreadId: string, connectionId: Id<"t3Connections">) {
  const rows = await ctx.db
    .query("linearIssueThreads")
    .withIndex("by_owner_thread", (q) =>
      q.eq("ownerSubject", subject).eq("ownerIssuer", issuer).eq("t3ThreadId", t3ThreadId))
    .take(10);
  const foreign = rows.find((row) => String(row.t3ConnectionId) !== String(connectionId));
  if (foreign) {
    throw new Error("T3 thread is already associated under a different connection");
  }
  return rows.find((row) => String(row.t3ConnectionId) === String(connectionId) && row.unlinkedAt === undefined) ?? null;
}

async function deleteLedgerRows(ctx: MutationCtx, associationId: Id<"linearIssueThreads">) {
  const rows = await ctx.db
    .query("linearSyncLedger")
    .withIndex("by_association", (q) => q.eq("associationId", associationId))
    .take(5);
  for (const row of rows) await ctx.db.delete(row._id);
}

async function insertAssociationAndLedger(ctx: MutationCtx, subject: string, issuer: string, revision: number, mapping: Doc<"linearProjectMappings">, linearIssueId: string, linearIssueIdentifier: string, t3ThreadId: string, note: string | undefined, now: number, prior: Doc<"linearIssueThreads"> | null) {
  const associationId = await ctx.db.insert("linearIssueThreads", {
    ownerSubject: subject,
    ownerIssuer: issuer,
    ownerRevision: revision,
    linearWorkspaceId: mapping.linearWorkspaceId,
    linearProjectId: mapping.linearProjectId,
    linearTeamId: mapping.linearTeamId,
    linearIssueId,
    linearIssueIdentifier,
    t3ConnectionId: mapping.t3ConnectionId,
    t3EnvironmentId: mapping.t3EnvironmentId,
    t3ProjectId: mapping.t3ProjectId,
    t3ThreadId,
    // A manually linked thread has NO launch attempt and NO correlation key.
    // Empty strings mark the absence of launch evidence (contrast with
    // launch-derived rows, which carry the accepted attempt id and key).
    attemptId: "",
    correlationKey: "",
    createdAt: now,
    note: note ? `manual link: ${note}` : "manual link",
    ...(prior && prior.attemptId !== "" ? { supersededAttemptId: prior.attemptId } : {}),
    ...(prior && prior.correlationKey !== "" ? { supersededCorrelationKey: prior.correlationKey } : {}),
  });
  await ctx.db.insert("linearSyncLedger", {
    ownerSubject: subject,
    ownerIssuer: issuer,
    ownerRevision: revision,
    associationId,
    linearWorkspaceId: mapping.linearWorkspaceId,
    linearIssueId,
    linearIssueIdentifier,
    linearTeamId: mapping.linearTeamId,
    targetStateId: null,
    targetStateName: null,
    state: "linked" as const,
    provenance: "manual" as const,
    attemptCount: 0,
    lastErrorCode: null,
    observedStateId: null,
    observedStateName: null,
    observedStateType: null,
    createdAt: now,
    updatedAt: now,
  });
  return associationId;
}

async function linkHandler(
  ctx: MutationCtx,
  args: LinkArgs,
  mode: "link" | "reassign" = "link",
): Promise<{ associationId: Id<"linearIssueThreads">; created: boolean }> {
  const subject = args.subject;
  const issuer = args.ownerIssuer;
  const revision = args.revision;
  const owner = { subject, issuer, revision };
  await requireCurrentOwnerGrant(ctx, owner);

  const n = norm(args);

  // F12: validate lengths; cap note.
  const linearProjectId = requiredId(n.linearProjectId, "The Linear project identity");
  const linearTeamId = requiredId(n.linearTeamId, "The Linear team identity");
  const linearIssueId = requiredId(n.linearIssueId, "The Linear issue identity");
  n.linearProjectId = linearProjectId;
  n.linearTeamId = linearTeamId;
  n.linearIssueId = linearIssueId;
  if (n.note !== undefined && n.note.length > 500) {
    throw new Error("The operator note is too long");
  }

  const mapping = await resolveMapping(ctx, subject, issuer, revision, n);
  const current = await currentAssociationForThread(ctx, subject, issuer, n.t3ThreadId, mapping.t3ConnectionId);

  // Already linked to the SAME issue: idempotent.
  if (current && current.linearIssueId === n.linearIssueId) {
    if (
      current.linearWorkspaceId !== mapping.linearWorkspaceId ||
      current.linearProjectId !== mapping.linearProjectId ||
      current.linearTeamId !== mapping.linearTeamId ||
      current.t3EnvironmentId !== mapping.t3EnvironmentId ||
      current.t3ProjectId !== mapping.t3ProjectId
    ) {
      throw new Error("Linear project or T3 destination does not match the existing association");
    }
    return { associationId: current._id, created: false };
  }

  // Reassignment path: thread already bound to a DIFFERENT issue.
  if (current) {
    if (!n.confirm) {
      throw new Error("Explicit confirmation is required to reassign a thread to a different Linear issue");
    }
    if (n.expectedAssociationId === undefined) {
      throw new Error("Expected association id is required to reassign a thread");
    }
    if (String(current._id) !== String(n.expectedAssociationId)) {
      throw new Error(`reassignment conflict: current=${current._id} expected=${n.expectedAssociationId}`);
    }
    const hasLaunchEvidence = current.attemptId !== "" || current.correlationKey !== "";
    if (hasLaunchEvidence && !n.confirmLaunchEvidenceLoss) {
      throw new Error("Reassigning a thread with launch evidence requires explicit confirmation of launch-evidence loss");
    }
    // Tombstone? No, delete old association row? Keep tombstone for unlink only.
    // Reassignment replaces binding: carry prior evidence into superseded fields.
    await deleteLedgerRows(ctx, current._id);
    await ctx.db.patch(current._id, { unlinkedAt: Date.now() });
    // insert new row with superseded evidence
    const now = Date.now();
    const associationId = await insertAssociationAndLedger(
      ctx, subject, issuer, revision, mapping, n.linearIssueId, n.linearIssueIdentifier, n.t3ThreadId,
      n.note, now, current,
    );
    return { associationId, created: true };
  }

  // mode reassign on unbound thread must not silently create.
  if (mode === "reassign") {
    throw new Error("The T3 thread is not currently associated; link it first");
  }

  const now = Date.now();
  const associationId = await insertAssociationAndLedger(
    ctx, subject, issuer, revision, mapping, n.linearIssueId, n.linearIssueIdentifier, n.t3ThreadId, n.note, now, null,
  );
  return { associationId, created: true };
}

async function unlinkHandler(ctx: MutationCtx, args: LinkArgs): Promise<{ removed: boolean; deleted: boolean; unlinked: boolean; associationId: Id<"linearIssueThreads"> | null }> {
  const subject = args.subject;
  const issuer = args.ownerIssuer;
  const revision = args.revision;
  const owner = { subject, issuer, revision };
  await requireCurrentOwnerGrant(ctx, owner);

  const n = norm(args);

  // F12: cap note (if provided) and validate thread id shape.
  if (n.note !== undefined && n.note.length > 500) {
    throw new Error("The operator note is too long");
  }
  if (n.t3ThreadId && !isValidT3ThreadId(n.t3ThreadId)) {
    throw new Error("The T3 thread identity is invalid");
  }

  let row: Doc<"linearIssueThreads"> | null = null;
  if (n.associationIdArg) {
    const fetched = await ctx.db.get(n.associationIdArg as Id<"linearIssueThreads">);
    if (fetched && (fetched.ownerSubject !== subject || fetched.ownerIssuer !== issuer)) {
      throw new Error("Association is unavailable");
    }
    row = fetched;
  } else {
    const rows = await ctx.db
      .query("linearIssueThreads")
      .withIndex("by_owner_thread", (q) =>
        q.eq("ownerSubject", subject).eq("ownerIssuer", issuer).eq("t3ThreadId", n.t3ThreadId))
      .take(10);
    const filtered = rows.filter((r) => {
      if (r.unlinkedAt !== undefined) return false;
      if (n.t3ConnectionIdArg && String(r.t3ConnectionId) !== String(n.t3ConnectionIdArg)) return false;
      return true;
    });
    row = filtered[0] ?? null;
  }

  if (!row || row.unlinkedAt !== undefined) {
    if (!n.confirm) {
      throw new Error("Explicit confirmation is required to unlink a thread");
    }
    return { removed: false, deleted: false, unlinked: false, associationId: null };
  }

  if (!n.confirm) {
    throw new Error("Explicit confirmation is required to unlink a thread");
  }
  if (n.expectedAssociationId === undefined) {
    throw new Error("Expected association id is required to unlink a thread");
  }
  if (String(row._id) !== String(n.expectedAssociationId)) {
    throw new Error("unlink conflict: the thread's association changed concurrently; retry with the current association");
  }

  if (n.t3ThreadId && row.t3ThreadId !== n.t3ThreadId) {
    throw new Error("T3 thread does not match the association");
  }
  if (n.t3ConnectionIdArg && String(row.t3ConnectionId) !== String(n.t3ConnectionIdArg)) {
    throw new Error("T3 connection does not match the association");
  }

  // Tombstone (F9) + ledger deletion (F10).
  await deleteLedgerRows(ctx, row._id);
  await ctx.db.patch(row._id, { unlinkedAt: Date.now() });
  return { removed: true, deleted: true, unlinked: true, associationId: row._id };
}

// Primary exports.
export const link = internalMutation({ args: linkArgsValidator, handler: async (ctx, args) => linkHandler(ctx, args as LinkArgs, "link") });
export const unlink = internalMutation({ args: linkArgsValidator, handler: async (ctx, args) => unlinkHandler(ctx, args as LinkArgs) });
export const reassign = internalMutation({ args: linkArgsValidator, handler: async (ctx, args) => linkHandler(ctx, args as LinkArgs, "reassign") });