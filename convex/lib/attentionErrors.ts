/**
 * Fixed invalid-request message for the native attention read (EGA-765).
 *
 * A request-shape refusal, never an upstream failure: the route repeats this
 * exact sentence as a 400, so an unsupported thread identifier produces clear,
 * safe copy instead of an opaque 502. No upstream text, token or identifier is
 * included.
 */

/** The attention request failed shape validation. */
export const ATTENTION_REQUEST_INVALID =
  "Select a supported T3 thread to inspect its attention state.";

/** Every message the attention route may repeat verbatim. */
export const ATTENTION_KNOWN_MESSAGES: readonly string[] = [
  ATTENTION_REQUEST_INVALID,
];
