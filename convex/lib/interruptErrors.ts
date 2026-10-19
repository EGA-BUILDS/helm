/**
 * Fixed invalid-request message for the native interrupt path (EGA-765).
 *
 * A request-shape refusal, not an interrupt-domain failure: it is THROWN
 * (never returned as an interrupt outcome) so the HTTP route can report it
 * as `invalid_request`. Fixed sanitized sentence — no upstream text, no
 * token, no identifier.
 *
 * Pure and dependency-free so both the Convex action (`convex/t3Interrupt.ts`)
 * and the Next route (`src/app/api/t3/threads/interrupt/route.ts`) can import
 * it. The route allowlists exactly this set: any other thrown message falls
 * back to the sanitized `safeFailure` classifier.
 */

/** The interrupt request failed shape validation. */
export const INTERRUPT_REQUEST_INVALID =
  "The interrupt request is invalid.";

/** Every message the interrupt route may repeat verbatim. */
export const INTERRUPT_KNOWN_MESSAGES: readonly string[] = [
  INTERRUPT_REQUEST_INVALID,
];

/** Throw one of the known invalid-request messages. Returns `never`. */
export function throwInterruptInvalid(message: string): never {
  throw new Error(message);
}
