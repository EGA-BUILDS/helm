"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { isValidT3ThreadId } from "./lib/threadIdentity";

/**
 * Owner-gated Linear issue <-> native T3 thread association actions (EGA-762).
 *
 * The durable store lives in `linearAssociationStore.ts` (internal queries and
 * mutations); this thin action layer resolves the owner from the authenticated
 * identity, validates shapes, and refuses unless BOTH halves of the identity
 * are already durable:
 *
 *  - `projectMappingsStore.resolveMappingForIssue` supplies the enabled
 *    mapping (workspace / project / team plus the T3 connection / environment
 *    / project), and
 *  - the `launchAttempts` row (read through `launchEvidence`) must prove the
 *    attempt is ACCEPTED (`acknowledged`) or RECOVERED (`reconciled`) and
 *    matches the exact issue key and thread id being claimed. The ISSUE and
 *    THREAD half is genuinely unforgeable — it is read only from the attempt
 *    row. The MAPPING half is caller-selected (which enabled mapping to name),
 *    but it is then BOUND to the evidence: the attempt's recorded
 *    `targetProjectId` must equal the mapping's t3 project, so a caller can
 *    never attach a launch to a mapping that points somewhere else.
 *
 * Retrying the same
 * recording is idempotent on the (owner, issue, thread) pair.
 */

const MAX_ID_LENGTH = 1024;

function requiredId(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

const recordReturns = v.object({
  associationId: v.id("linearIssueThreads"),
  created: v.boolean(),
});
type RecordReturns = Infer<typeof recordReturns>;

export const recordFromLaunch = action({
  args: {
    linearProjectId: v.string(),
    linearTeamId: v.string(),
    linearIssueId: v.string(),
    attemptId: v.string(),
    threadId: v.string(),
  },
  returns: recordReturns,
  handler: async (ctx: ActionCtx, args): Promise<RecordReturns> => {
    const owner = await ctx.runQuery(internal.linearAssociationStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });

    const linearProjectId = requiredId(args.linearProjectId, "The Linear project identity");
    const linearTeamId = requiredId(args.linearTeamId, "The Linear team identity");
    const linearIssueId = requiredId(args.linearIssueId, "The Linear issue identity");
    const attemptId = requiredId(args.attemptId, "The attempt identity");
    if (!isValidT3ThreadId(args.threadId)) throw new Error("The T3 thread identity is invalid");
    await assertOwnerCurrent();

    // The enabled mapping supplies — and binds — both identity halves.
    const mapping = await ctx.runQuery(internal.projectMappingsStore.resolveMappingForIssue, {
      subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision,
      linearProjectId, linearTeamId,
    });
    if (!mapping) {
      throw new Error("No enabled mapping for this Linear project and team; map it first.");
    }

    // The launch evidence must already be durable. Read the attempt row and
    // require acceptance: acknowledged, or reconciled to exactly one thread.
    const evidence = await ctx.runQuery(internal.linearAssociationStore.launchEvidence, { attemptId });
    if (evidence === null) {
      throw new Error("The launch attempt could not be found; no association was recorded.");
    }
    if (evidence.issueKey !== linearIssueId) {
      throw new Error("The launch attempt belongs to a different Linear issue; nothing was recorded.");
    }
    if (evidence.threadId !== args.threadId) {
      throw new Error("The launch attempt belongs to a different T3 thread; nothing was recorded.");
    }
    if (evidence.state !== "acknowledged" && evidence.state !== "reconciled") {
      throw new Error(
        `The launch attempt is ${evidence.state}; only accepted (acknowledged/reconciled) launches are associated.`,
      );
    }
    if (evidence.correlationKey === null) {
      throw new Error("The launch attempt has no correlation key; no association was recorded.");
    }
    // The mapping half is caller-selected, but it is bound to the launch's
    // own recorded target: the attempt stored `targetProjectId` at reservation
    // time, and a mapping that points anywhere else is a forgery surface the
    // evidence must close (F2). A legacy attempt row with no recorded target
    // is refused for the same reason.
    if (evidence.targetProjectId === null || evidence.targetProjectId !== mapping.t3ProjectId) {
      throw new Error(
        "The launch attempt targeted a different T3 project than the mapping; nothing was recorded.",
      );
    }

    await assertOwnerCurrent();
    // The human-readable issue label comes from the durable attempt row when
    // it carries one; the issue id is the evidence fallback. Never a
    // caller-supplied label.
    const linearIssueIdentifier = evidence.issueIdentifier ?? linearIssueId;
    const result = await ctx.runMutation(internal.linearAssociationStore.ensureAssociation, {
      subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision,
      linearWorkspaceId: mapping.linearWorkspaceId,
      linearProjectId: mapping.linearProjectId,
      linearTeamId: mapping.linearTeamId,
      linearIssueId,
      linearIssueIdentifier,
      t3ConnectionId: mapping.t3ConnectionId,
      t3EnvironmentId: mapping.t3EnvironmentId,
      t3ProjectId: mapping.t3ProjectId,
      t3ThreadId: args.threadId,
      attemptId,
      correlationKey: evidence.correlationKey,
      at: Date.now(),
    });
    return { associationId: result.associationId, created: result.created };
  },
});
