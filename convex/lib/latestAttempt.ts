/**
 * Single definition of "latest attempt for an issue" (cross-tab stale guard).
 *
 * Both the read path (`attemptsForIssue`, consumed by `api.t3Launch.recover`)
 * and the reservation precondition (`prepareLaunchAttempt`) use THIS helper,
 * so the reader and the precondition can never disagree about which attempt
 * is current.
 *
 * Ordering: Convex documents always carry `_creationTime`. The latest attempt
 * is the row with the greatest `_creationTime`; a tie (same millisecond)
 * breaks deterministically on `_id` lexical order. The `by_issue_key` index
 * is single-field, so recency order is established HERE in JavaScript — not
 * by relying on index scan order.
 *
 * Documented bound: at most `LATEST_ATTEMPT_SCAN_LIMIT` rows per issue are
 * examined. A human-confirmed native launch creates one row per execution,
 * so per-issue history stays tiny; 1000 rows is orders of magnitude above
 * any real history while keeping the scan bounded. `attemptsForIssue` still
 * applies its own smaller caller-supplied window AFTER this deterministic
 * sort, so its "newest first" list and this helper agree.
 */

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const LATEST_ATTEMPT_SCAN_LIMIT = 1000;

export type IssueAttemptRow = Doc<"launchAttempts">;

/** Newest first: `_creationTime` desc, `_id` desc as a deterministic tiebreak. */
export function compareAttemptsNewestFirst(a: IssueAttemptRow, b: IssueAttemptRow): number {
  if (a._creationTime !== b._creationTime) return b._creationTime - a._creationTime;
  if (a._id === b._id) return 0;
  return a._id > b._id ? -1 : 1;
}

/** Deterministic newest-first sort; does not mutate the input. */
export function sortAttemptsNewestFirst(rows: readonly IssueAttemptRow[]): IssueAttemptRow[] {
  return [...rows].sort(compareAttemptsNewestFirst);
}

/** The single "current latest attempt" for an issue, or null when none. */
export function pickLatestAttempt(rows: readonly IssueAttemptRow[]): IssueAttemptRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  for (let i = 1; i < rows.length; i++) {
    if (compareAttemptsNewestFirst(rows[i]!, best) < 0) best = rows[i]!;
  }
  return best;
}

type IssueDb = QueryCtx["db"] | MutationCtx["db"];

/**
 * Read the current latest attempt for one issue, newest-first per the rule
 * above. Shared by the `attemptsForIssue` reader and the
 * `prepareLaunchAttempt` precondition (which calls it inside the reserving
 * mutation, so the read and the insert are atomic under Convex serializable
 * OCC).
 */
export async function readLatestAttemptForIssue(
  db: IssueDb,
  issueKey: string,
): Promise<IssueAttemptRow | null> {
  const rows = await db
    .query("launchAttempts")
    .withIndex("by_issue_key", (q) => q.eq("issueKey", issueKey))
    .take(LATEST_ATTEMPT_SCAN_LIMIT);
  return pickLatestAttempt(rows);
}
