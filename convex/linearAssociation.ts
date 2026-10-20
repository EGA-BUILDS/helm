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
 * Retrying the same recording is idempotent on the (owner, issue, thread)
 * pair. All recording logic — validation, evidence checks, refusal
 * classification, and the N6 failure marker — lives in the store's
 * `recordFromLaunchInternal` internal mutation; this public action is the
 * owner-gated entry point and rethrows the same fixed refusal sentences the
 * launch path swallows.
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

    // One internal mutation performs the whole recording (N8): same
    // transaction covers the evidence reads, the idempotent creation, and —
    // on refusal — the durable N6 marker on the attempt row.
    const result = await ctx.runMutation(internal.linearAssociationStore.recordFromLaunchInternal, {
      subject: owner.subject,
      ownerIssuer: owner.issuer,
      revision: owner.revision,
      linearProjectId, linearTeamId, linearIssueId,
      attemptId,
      threadId: args.threadId,
    });
    if (result.refusal !== null) {
      throw new Error(result.message ?? result.refusal);
    }
    if (result.associationId === null) {
      throw new Error("The launch attempt could not be associated; nothing was recorded.");
    }
    return { associationId: result.associationId, created: result.created };
  },
});
