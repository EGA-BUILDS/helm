/**
 * Same-origin HTTP recovery for the launch route's GET handler.
 *
 * Convex is the source of truth: after a full browser reload the execute
 * panel calls this instead of trusting module-level browser storage, so it
 * can never mint a fresh attemptId while the same issue already has an
 * unresolved attempt server-side. Decoded exactly once here, at the transport
 * boundary. Local storage may be retained as an optimisation, but every
 * decision below is correct when it is empty.
 *
 * Read-only: this adapter never launches, mutates, reconciles, or writes a
 * Linear status. No Clerk token is sent from the browser.
 */

export {
  blockersForOutcome,
  blockerForAmbiguousAttempt,
  blockerForUnresolvedAttempt,
  canStartNewExecutionForOutcome,
  deriveOutcomeForAttempt,
} from "../../../convex/lib/attemptRecovery";
export type {
  AttemptRecoveryLatest,
  AttemptRecoveryOutcome,
} from "../../../convex/lib/attemptRecovery";

import type {
  AttemptRecoveryLatest,
  AttemptRecoveryOutcome,
} from "../../../convex/lib/attemptRecovery";

export interface AttemptRecovery {
  latest: AttemptRecoveryLatest | null;
  outcome: AttemptRecoveryOutcome;
  canStartNewExecution: boolean;
  blockers: string[];
}

export interface RecoverInput {
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
}

const OUTCOMES: readonly string[] = ["none", "unresolved", "acknowledged", "ambiguous", "abandoned"];

type Json = Record<string, unknown>;

function malformed(what: string): never {
  throw new Error(`Helm could not read ${what} from the execution backend.`);
}

function objectAt(value: unknown, what: string): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Json;
  }
  return malformed(what);
}

function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : malformed(what);
}

function optionalNumber(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : malformed(what);
}

function decodeLatest(value: unknown): AttemptRecoveryLatest | null {
  if (value === null || value === undefined) return null;
  const raw = objectAt(value, "a recovery attempt");
  const attemptId = optionalText(raw.attemptId, "a recovery attempt id");
  const state = optionalText(raw.state, "a recovery attempt state");
  const correlationKey = optionalText(raw.correlationKey, "a recovery correlation key");
  if (attemptId === null || state === null || correlationKey === null) {
    return malformed("a recovery attempt");
  }
  return {
    attemptId,
    state,
    threadId: optionalText(raw.threadId, "a recovery thread id"),
    correlationKey,
    dispatchedAt: optionalNumber(raw.dispatchedAt, "a recovery dispatch time"),
    acknowledgedAt: optionalNumber(raw.acknowledgedAt, "a recovery acknowledgement time"),
    matchCount: optionalNumber(raw.matchCount, "a recovery match count"),
  };
}

export function decodeAttemptRecovery(value: unknown): AttemptRecovery {
  const raw = objectAt(value, "an attempt recovery");
  const outcome = optionalText(raw.outcome, "a recovery outcome");
  if (outcome === null || !OUTCOMES.includes(outcome)) return malformed("a recovery outcome");
  if (typeof raw.canStartNewExecution !== "boolean") return malformed("a recovery permission");
  if (!Array.isArray(raw.blockers) || !raw.blockers.every((entry) => typeof entry === "string")) {
    return malformed("recovery blockers");
  }
  return {
    latest: decodeLatest(raw.latest),
    outcome: outcome as AttemptRecoveryOutcome,
    canStartNewExecution: raw.canStartNewExecution,
    blockers: raw.blockers as string[],
  };
}

/**
 * The recovery's contribution to launch availability. Returns null when the
 * recovery imposes no restriction (no history, abandoned, or an acknowledged
 * attempt with a separately confirmed new execution). A failed or pending
 * fetch is NOT represented here: the panel disables launch separately while
 * the server state is unknown, because failing open would reintroduce both
 * defects.
 */
export function recoveryLaunchGate(
  recovery: AttemptRecovery,
  opts: { newExecutionArmed: boolean },
): { disabled: boolean; reason: string | null } | null {
  if (recovery.outcome === "none" || recovery.outcome === "abandoned") return null;
  if (recovery.outcome === "unresolved" || recovery.outcome === "ambiguous") {
    return {
      disabled: true,
      reason: recovery.blockers[0] ?? "This issue has a prior launch attempt; reconcile it before launching again.",
    };
  }
  if (opts.newExecutionArmed) return null;
  const thread = recovery.latest?.threadId;
  return {
    disabled: true,
    reason: thread
      ? `Already launched as thread ${thread} — start a new execution below to run again.`
      : "This issue already has a launched execution — start a new execution below to run again.",
  };
}

/**
 * Attempt identity for one explicit owner action. An explicit retry of an
 * unresolved attempt adopts the SERVER's attemptId so `prepareLaunchAttempt`
 * returns `reused: true`; every new execution mints a fresh id (only when
 * the server allows it). The local record is never consulted here — it is a
 * convenience that may be empty after a hard reload.
 */
export function chooseAttemptIdForLaunch(input: {
  recovery: AttemptRecovery | null;
  retryStoredAttempt: boolean;
  mint: () => string;
}): string {
  if (input.retryStoredAttempt && input.recovery?.latest) {
    return input.recovery.latest.attemptId;
  }
  return input.mint();
}
