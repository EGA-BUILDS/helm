/**
 * Fixed, sanitised messages for the DIRECT project launch path (EGA-812).
 *
 * Pure and dependency-free so the Convex ledger/action and the later
 * EGA-813 route can share exactly one vocabulary. Every sentence is fixed
 * text: no upstream body, no token, no caller-supplied value is echoed.
 */

/** The direct launch request failed shape validation. */
export const DIRECT_REQUEST_INVALID = "The direct launch request is invalid.";

/** Same intent id presented with a different canonical payload. */
export const DIRECT_PAYLOAD_MISMATCH =
  "This direct launch intent was already reserved with a different payload; start a new intent.";

/** Same intent id presented for a different connection/environment/project. */
export const DIRECT_TARGET_MISMATCH =
  "This direct launch intent was already reserved for a different T3 target; start a new intent.";

/**
 * The credential namespace recorded at reservation no longer matches the
 * connection. A native `clientRequestId` is only idempotent inside one
 * namespace, so nothing is re-sent: the caller keeps the original attempt and
 * either reconciles it or explicitly starts a new intent.
 */
export const DIRECT_NAMESPACE_CHANGED =
  "The T3 connection changed after this direct launch intent was reserved; no launch was sent on the new connection. Reconcile the original intent or start a new one.";

/** A retry presented an intent an operator explicitly abandoned. */
export const DIRECT_ABANDONED_RETRY =
  "This direct launch intent was abandoned; start a new intent to launch again.";

/** The intent id is unknown (or belongs to another owner). */
export const DIRECT_ATTEMPT_UNKNOWN =
  "This direct launch intent is not known for the current owner.";
