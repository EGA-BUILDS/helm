/**
 * Self-contained follow-up control for one selected native T3 thread
 * (EGA-764 D10).
 *
 * The integration owner renders `<FollowUpControl connectionId projectId
 * threadId />` wherever the thread selection already lives. No shared
 * Dashboard/controller file is touched: the thread identity arrives as props,
 * the message is composed here, and the owner-gated send goes through
 * `createSendAdapter` to `/api/t3/threads/send`.
 *
 * Honesty rules, enforced by construction:
 * - the exact thread identity (connection, project, thread) is always shown;
 * - an accepted/queued message is NEVER described as executed or complete;
 * - one idempotency key is minted per composed message and REUSED across
 *   retries of the same message, so a retry after an ambiguous acknowledgement
 *   lets the native server deduplicate instead of double-sending;
 * - editing the message mints a fresh key and clears the previous result;
 * - every result belongs to the selection that produced it: the draft, the
 *   idempotency key, the phase and the receipt are stored PER SELECTION, so a
 *   response that arrives after the owner moved to another thread can never
 *   be rendered under the new selection;
 * - `onAccepted` fires only for a native acknowledgement (accepted/queued).
 *   It is not a completion signal: the message has not run.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSendAdapter,
  mintClientRequestId,
  toSendError,
  type SendAdapter,
  type SendError,
  type SendResult,
} from "./send";
import { followUpIdentityKey, followUpRequestId, isAcknowledged, responseIsCurrent, resultMatchesIdentity } from "./followUp";

export interface FollowUpIdentity {
  connectionId: string;
  projectId: string;
  threadId: string;
  threadTitle?: string | null;
}

export interface FollowUpControlProps extends FollowUpIdentity {
  /** Override for tests; defaults to the same-origin HTTP adapter. */
  adapter?: SendAdapter;
  /**
   * Called ONLY after the native server acknowledged the send (accepted or
   * queued) — for example to re-read the thread so the new activity appears.
   *
   * It is NOT a completion signal: an acknowledged message has not run yet,
   * and a rejected or ambiguous outcome never calls it.
   */
  onAccepted?: () => void;
}

export type FollowUpPhase = "idle" | "sending" | "done";

/**
 * Owner-facing copy for a send outcome.
 *
 * The outcome sentence comes from the backend (a fixed, sanitized string).
 * The duplicate sentence states only what the native thread activity showed;
 * an unverified observation is stated as unverified, never as "no duplicate".
 */
export function followUpStatusCopy(result: SendResult): string {
  // Only an acknowledgement carries a duplicate observation; a refusal or an
  // ambiguous outcome never reached a state where duplicates could be read.
  if (!isAcknowledged(result.outcome)) return result.detail;
  return `${result.detail} ${followUpDedupeCopy(result.dedupe)}`;
}

/** The honest sentence for what the thread activity showed about duplicates. */
export function followUpDedupeCopy(dedupe: SendResult["dedupe"]): string {
  switch (dedupe) {
    case "not_duplicate_observed":
      return "Helm observed exactly one native activity entry for this request id.";
    case "duplicate_observed":
      return "The thread already held this request id's activity and no new entry appeared, so this request created no second message.";
    case "unverified":
      return "Helm could not verify whether this request id had been used before.";
  }
}

/**
 * Everything the control knows about ONE selection: its draft, its
 * idempotency key, its phase and its receipt. Keying the state by the
 * selection is what makes a stale result impossible to render: a result
 * simply belongs to another entry.
 */
interface FollowUpEntry {
  message: string;
  /** One logical message carries one key; a retry reuses it. */
  clientRequestId: string | null;
  phase: FollowUpPhase;
  result: SendResult | null;
  error: SendError | null;
}

const EMPTY_ENTRY: FollowUpEntry = {
  message: "",
  clientRequestId: null,
  phase: "idle",
  result: null,
  error: null,
};

export interface FollowUpViewProps extends FollowUpIdentity {
  message: string;
  phase: FollowUpPhase;
  result: SendResult | null;
  error: SendError | null;
  onMessageChange: (message: string) => void;
  onSend: () => void;
  onRetry: () => void;
}

export function FollowUpView(props: FollowUpViewProps) {
  const { connectionId, projectId, threadId, threadTitle } = props;
  const sending = props.phase === "sending";
  const canSend = props.message.trim().length > 0 && !sending;
  const showRetry =
    !sending && (props.error !== null || props.result?.outcome === "ambiguous" || props.result?.outcome === "rejected");
  return (
    <section aria-label="Follow-up prompt">
      <p>
        Follow-up on thread {threadTitle ? `"${threadTitle}" ` : ""}({threadId}) in project {projectId} via connection{" "}
        {connectionId}.
      </p>
      <label>
        Follow-up message
        <textarea
          aria-label="Follow-up message"
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
          disabled={sending}
          rows={4}
        />
      </label>
      <div>
        <button type="button" onClick={props.onSend} disabled={!canSend}>
          {sending ? "Sending…" : "Send follow-up"}
        </button>
        {showRetry ? (
          <button type="button" onClick={props.onRetry} disabled={sending}>
            Retry with the same request id
          </button>
        ) : null}
      </div>
      {props.result ? (
        <p role="status">
          {followUpStatusCopy(props.result)} (outcome: {props.result.outcome}
          {props.result.messageId ? `, message ${props.result.messageId}` : ""})
        </p>
      ) : null}
      {props.error ? <p role="alert">{props.error.message}</p> : null}
    </section>
  );
}

export function FollowUpControl({
  connectionId,
  projectId,
  threadId,
  threadTitle,
  adapter,
  onAccepted,
}: FollowUpControlProps) {
  const resolvedAdapter = useMemo(() => adapter ?? createSendAdapter(), [adapter]);
  const identityKey = followUpIdentityKey({ connectionId, projectId, threadId });
  // One entry per selection: the draft, the idempotency key, the phase and
  // the receipt of that selection only.
  const [entries, setEntries] = useState<Record<string, FollowUpEntry>>({});
  const entry = entries[identityKey] ?? EMPTY_ENTRY;
  // The identity the owner has selected RIGHT NOW. A response for any other
  // selection is stale and is discarded instead of being stored.
  const currentIdentityRef = useRef(identityKey);
  useEffect(() => {
    currentIdentityRef.current = identityKey;
  }, [identityKey]);
  // Selections with a send in flight: a second click for the SAME selection
  // never issues a second send.
  const inFlightRef = useRef<Set<string>>(new Set());
  // The receipt already reported to the owner, so one acknowledgement is
  // never announced twice.
  const notifiedRef = useRef<SendResult | null>(null);

  const updateEntry = (key: string, patch: Partial<FollowUpEntry>) => {
    setEntries((previous) => ({
      ...previous,
      [key]: { ...(previous[key] ?? EMPTY_ENTRY), ...patch },
    }));
  };

  const handleMessageChange = (next: string) => {
    // An edited message is a new message: a fresh key, and the previous
    // result for this selection is cleared.
    updateEntry(identityKey, {
      message: next,
      clientRequestId: null,
      phase: "idle",
      result: null,
      error: null,
    });
  };

  const runSend = async () => {
    const trimmed = entry.message.trim();
    if (trimmed.length === 0 || inFlightRef.current.has(identityKey)) return;
    // One logical message carries one key: a retry of the same message reuses
    // it (so the native server can deduplicate), an edited message gets a
    // fresh one.
    const clientRequestId = followUpRequestId(entry.clientRequestId, entry.message, mintClientRequestId);
    if (clientRequestId === null) return;
    const requestIdentity = identityKey;
    inFlightRef.current.add(requestIdentity);
    updateEntry(requestIdentity, {
      clientRequestId,
      phase: "sending",
      result: null,
      error: null,
    });
    try {
      const outcome = await resolvedAdapter.send({ connectionId, projectId, threadId, message: trimmed, clientRequestId });
      if (!responseIsCurrent(requestIdentity, currentIdentityRef.current)) {
        // The owner moved to another selection while this send was in flight.
        // The receipt belongs to the old selection and is discarded here; it
        // is never rendered under the new one.
        updateEntry(requestIdentity, { phase: "done" });
        return;
      }
      if (!resultMatchesIdentity(outcome, { connectionId, projectId, threadId })) {
        updateEntry(requestIdentity, {
          phase: "done",
          result: null,
          error: {
            code: "malformed_response",
            message: "Helm could not read the follow-up result for the selected thread.",
            retryable: false,
          },
        });
        return;
      }
      updateEntry(requestIdentity, { phase: "done", result: outcome, error: null });
    } catch (thrown) {
      if (!responseIsCurrent(requestIdentity, currentIdentityRef.current)) {
        updateEntry(requestIdentity, { phase: "done" });
        return;
      }
      updateEntry(requestIdentity, { phase: "done", result: null, error: toSendError(thrown) });
    } finally {
      inFlightRef.current.delete(requestIdentity);
    }
  };

  // The acknowledgement callback fires only for a receipt that belongs to the
  // CURRENT selection, and never for a rejection or an ambiguity.
  useEffect(() => {
    if (!entry.result || !isAcknowledged(entry.result.outcome)) return;
    if (notifiedRef.current === entry.result) return;
    notifiedRef.current = entry.result;
    onAccepted?.();
  }, [entry, onAccepted]);

  return (
    <FollowUpView
      connectionId={connectionId}
      projectId={projectId}
      threadId={threadId}
      threadTitle={threadTitle}
      message={entry.message}
      phase={entry.phase}
      result={entry.result}
      error={entry.error}
      onMessageChange={handleMessageChange}
      onSend={() => void runSend()}
      onRetry={() => void runSend()}
    />
  );
}
