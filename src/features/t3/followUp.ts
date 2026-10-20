/**
 * Pure rules for the native follow-up control (EGA-764 D10).
 *
 * These rules live outside the component on purpose: the frontend unit suite
 * runs in a node environment with no DOM, so the identity, idempotency and
 * staleness rules are unit tested here and the component only wires them to
 * React state.
 *
 * The three rules the control depends on:
 *  1. IDENTITY — a result belongs to the exact connection/project/thread it
 *     was requested for. A result whose identity no longer matches the
 *     current selection is dropped, never rendered.
 *  2. IDEMPOTENCY — one logical message carries one request id. The id is
 *     reused for a retry of the SAME message (so the native server can
 *     deduplicate it) and replaced when the message is edited.
 *  3. ACKNOWLEDGEMENT — only an accepted or queued outcome is an
 *     acknowledgement. It is never a statement that the message ran.
 */

import type { SendOutcome, SendResult } from "./send";

export interface FollowUpIdentity {
  connectionId: string;
  projectId: string;
  threadId: string;
}

/**
 * The identity of one selected thread. Thread ids are only unique inside a
 * project, so the full triple is used — never the thread id alone.
 */
export function followUpIdentityKey(identity: FollowUpIdentity): string {
  return JSON.stringify([identity.connectionId, identity.projectId, identity.threadId]);
}

/**
 * The request id a send must use.
 *
 * A retry of the SAME message keeps the existing id (the native server
 * deduplicates a replayed `clientRequestId`), while an edited message gets a
 * fresh one — one logical message, one key. An empty message has no key.
 */
export function followUpRequestId(
  current: string | null,
  message: string,
  mint: () => string,
): string | null {
  if (message.trim().length === 0) return null;
  return current ?? mint();
}

/**
 * True when a result may be shown for the current selection.
 *
 * The backend echoes the thread it answered for; anything else is a result
 * for a different thread and is never rendered under this one.
 */
export function resultMatchesIdentity(result: SendResult, identity: FollowUpIdentity): boolean {
  return result.threadId === identity.threadId;
}

/**
 * True when a response may still be applied.
 *
 * A response that arrives after the owner moved to another thread (or
 * another project or another connection) is stale: applying it would show
 * thread A's receipt while thread B is selected.
 */
export function responseIsCurrent(requestIdentity: string, currentIdentity: string): boolean {
  return requestIdentity === currentIdentity;
}

/**
 * True when the native server acknowledged the send.
 *
 * `accepted` and `queued` are acknowledgements; `rejected` and `ambiguous`
 * are not. An acknowledgement says the message was taken, never that it ran.
 */
export function isAcknowledged(outcome: SendOutcome): boolean {
  return outcome === "accepted" || outcome === "queued";
}
