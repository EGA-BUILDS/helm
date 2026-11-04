/**
 * Pure mapping for the rare "someone else changed the intent between my
 * reservation read and my dispatch claim" race (EGA-812).
 *
 * The claim mutation is the only place a second launch can be stopped. When it
 * returns false the caller must report the DURABLE outcome it found, not a
 * blanket "in progress": a concurrent invocation may already have settled the
 * attempt. Dependency-free so the branch is unit-testable without a live
 * action.
 */

export type UnclaimedAttemptOutcome =
  | { kind: "settled"; threadId: string }
  | { kind: "ambiguous" }
  | { kind: "abandoned" }
  | { kind: "in_progress" };

export function classifyUnclaimedAttempt(
  row: { state: string; threadId: string | null } | null,
): UnclaimedAttemptOutcome {
  if (!row) return { kind: "in_progress" };
  if ((row.state === "acknowledged" || row.state === "reconciled") && row.threadId) {
    return { kind: "settled", threadId: row.threadId };
  }
  if (row.state === "ambiguous") return { kind: "ambiguous" };
  if (row.state === "abandoned") return { kind: "abandoned" };
  return { kind: "in_progress" };
}
