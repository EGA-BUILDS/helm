/**
 * Owner-visible derivation for launch-attempt recovery (EGA-681 follow-up).
 *
 * Pure and dependency-free so the Convex `recover` action and the browser
 * panel share these exact rules: the UI can never disagree with the server
 * about what an attempt state means. Convex is the source of truth — browser
 * storage is a convenience only.
 */

/** What the server reports for one issue's attempt history. */
export type AttemptRecoveryOutcome =
  | "none"
  | "unresolved"
  | "acknowledged"
  | "ambiguous"
  | "abandoned";

export interface AttemptRecoveryLatest {
  attemptId: string;
  state: string;
  threadId: string | null;
  correlationKey: string;
  dispatchedAt: number | null;
  acknowledgedAt: number | null;
  matchCount: number | null;
}

/**
 * Map a stored attempt state onto the owner-visible outcome. Settled states
 * (acknowledged, reconciled) share one outcome: both carry a confirmed
 * thread. Anything not explicitly terminal fails closed as unresolved, so an
 * unknown state can never unlock a new execution.
 */
export function deriveOutcomeForAttempt(state: string | null): AttemptRecoveryOutcome {
  if (state === null) return "none";
  if (state === "acknowledged" || state === "reconciled") return "acknowledged";
  if (state === "ambiguous") return "ambiguous";
  if (state === "abandoned") return "abandoned";
  return "unresolved";
}

/**
 * A new execution is allowed ONLY when no attempt is unresolved: no history
 * at all, a settled attempt, or an explicitly abandoned one. Unresolved
 * (prepared / dispatching) and ambiguous attempts keep the lock.
 */
export function canStartNewExecutionForOutcome(outcome: AttemptRecoveryOutcome): boolean {
  return outcome === "none" || outcome === "acknowledged" || outcome === "abandoned";
}

/** Actionable blocker for an unresolved attempt; names the owning attempt. */
export function blockerForUnresolvedAttempt(attemptId: string, state: string): string {
  return (
    `This issue already has an unresolved launch attempt (${attemptId}, state ${state}); ` +
    "reconcile or abandon it before launching again."
  );
}

/** Actionable blocker for an ambiguous attempt; never authorizes a relaunch. */
export function blockerForAmbiguousAttempt(): string {
  return "This launch ended ambiguous; reconcile it before launching again.";
}

/** Blockers for an outcome; empty exactly when a new execution may start. */
export function blockersForOutcome(
  outcome: AttemptRecoveryOutcome,
  latest: AttemptRecoveryLatest | null,
): string[] {
  if (outcome === "unresolved" && latest !== null) {
    return [blockerForUnresolvedAttempt(latest.attemptId, latest.state)];
  }
  if (outcome === "ambiguous") {
    return [blockerForAmbiguousAttempt()];
  }
  return [];
}
