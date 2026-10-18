/**
 * Fixed invalid-request messages for the native launch path (EGA-681).
 *
 * These are request-shape refusals, not launch-domain failures: they are
 * THROWN (never returned as a launch outcome) so the HTTP route can report
 * them as `invalid_request`. The set is deliberately tiny and every message
 * is a fixed sanitized sentence — no upstream text, no token, no identifier
 * longer than a bounded request id.
 *
 * Pure and dependency-free so both the Convex action (`convex/t3Launch.ts`)
 * and the Next route (`src/app/api/t3/launch/route.ts`) can import it. The
 * route allowlists exactly this set: any other thrown message falls back to
 * the sanitized `safeFailure` classifier.
 */

/** The launch request failed shape validation. */
export const LAUNCH_REQUEST_INVALID =
  "The launch request is invalid.";

/** The native launch cannot express a subagent preference yet. */
export const LAUNCH_SUBAGENTS_UNSUPPORTED =
  "Subagent preference cannot be forwarded to the native launch yet; switch subagents off to launch.";

/** The same attempt id was presented with a different payload. */
export const LAUNCH_PAYLOAD_MISMATCH =
  "This launch request does not match its reservation; start a new execution with a new request id.";

/** A retry presented an attempt id an operator explicitly abandoned. */
export const LAUNCH_ABANDONED_RETRY =
  "This launch reservation was abandoned by an operator; start a new execution to launch again.";

/** Every message the launch route may repeat verbatim. */
export const LAUNCH_KNOWN_MESSAGES: readonly string[] = [
  LAUNCH_REQUEST_INVALID,
  LAUNCH_SUBAGENTS_UNSUPPORTED,
  LAUNCH_PAYLOAD_MISMATCH,
  LAUNCH_ABANDONED_RETRY,
];

/** Throw one of the known invalid-request messages. Returns `never`. */
export function throwLaunchInvalid(message: string): never {
  throw new Error(message);
}
