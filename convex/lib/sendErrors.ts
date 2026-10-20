/**
 * Fixed invalid-request messages for the native follow-up path (EGA-764).
 *
 * These are request-shape refusals, not send-domain failures: they are THROWN
 * (never returned as a send outcome) so the HTTP route can report them as
 * `invalid_request`. The set is deliberately tiny and every message is a fixed
 * sanitized sentence — no upstream text, no token, no identifier longer than a
 * bounded request field.
 *
 * Pure and dependency-free so both the Convex action (`convex/t3Send.ts`) and
 * the Next route (`src/app/api/t3/threads/send/route.ts`) can import it. The
 * route allowlists exactly this set: any other thrown message falls back to
 * the sanitized `safeFailure` classifier.
 */

/** The follow-up request failed shape validation. */
export const SEND_REQUEST_INVALID = "The follow-up request is invalid.";

/** The selected thread is not in the selected project; the send was refused. */
export const SEND_THREAD_MISMATCH =
  "The selected thread is not in the selected project; no message was sent.";

/** Every message the send route may repeat verbatim. */
export const SEND_KNOWN_MESSAGES: readonly string[] = [SEND_REQUEST_INVALID, SEND_THREAD_MISMATCH];

/** Throw one of the known invalid-request messages. Returns `never`. */
export function throwSendInvalid(message: string): never {
  throw new Error(message);
}
