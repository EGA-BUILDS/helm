/**
 * Shared native run-state classification for EGA-765 (interrupt + attention).
 *
 * Both the interrupt write path and the attention read path must agree on
 * what "active", "waiting", "terminal" and "unknown" mean: if each re-derived
 * it, an interrupt could fire at a run attention calls idle, or attention
 * could report `running` for a run the interrupt path treats as terminal.
 *
 * Pure and dependency-free (no Convex imports, no network, no clock) so it
 * can be unit tested exhaustively and imported by both Convex and the
 * browser. Statuses are matched case-insensitively on the lowercased value.
 */

export type RunKind =
  | "active"
  | "waiting"
  | "terminal"
  | "inflight_interrupt"
  | "unknown";

/**
 * Terminal run states observed in authorized probes and fixtures
 * (`starting` -> `interrupted`, plus the settled vocabulary around it).
 * Matching is exact on the lowercased status; anything unrecognized stays
 * `active` so an unknown-but-live run is never mistaken for a dead one —
 * except the empty string, which carries no signal at all (`unknown`).
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "succeeded",
  "done",
  "aborted",
  "expired",
  "terminated",
  "settled",
]);

/**
 * An interrupt that is already in flight. A second interrupt of the same run
 * must be reported honestly (no duplicate side effect), never re-dispatched.
 */
const INFLIGHT_INTERRUPT_STATUSES = new Set([
  "interrupt_requested",
  "interrupting",
  "cancelling",
  "cancel_requested",
]);

/**
 * Hints that an active run is waiting on the owner (approval, input, or a
 * paused/blocked turn). Substring match on the lowercased status: native
 * statuses compose (`awaiting_input`, `waiting_for_approval`), so an exact
 * vocabulary would silently miss the states attention exists to surface.
 */
const WAITING_HINTS = [
  "wait",
  "approval",
  "pending",
  "paused",
  "blocked",
  "input",
  "action_required",
];

export function classifyRunStatus(status: unknown): RunKind {
  if (typeof status !== "string") return "unknown";
  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) return "unknown";
  if (TERMINAL_RUN_STATUSES.has(normalized)) return "terminal";
  if (INFLIGHT_INTERRUPT_STATUSES.has(normalized)) return "inflight_interrupt";
  if (WAITING_HINTS.some((hint) => normalized.includes(hint))) return "waiting";
  return "active";
}

/** True only for runs that may still be doing work (active or waiting). */
export function isLiveRun(status: unknown): boolean {
  const kind = classifyRunStatus(status);
  return kind === "active" || kind === "waiting";
}
