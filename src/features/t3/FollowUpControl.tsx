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
 * - editing the message mints a fresh key and clears the previous result.
 */

import { useMemo, useRef, useState } from "react";
import {
  createSendAdapter,
  mintClientRequestId,
  toSendError,
  type SendAdapter,
  type SendError,
  type SendResult,
} from "./send";

export interface FollowUpIdentity {
  connectionId: string;
  projectId: string;
  threadId: string;
  threadTitle?: string | null;
}

export interface FollowUpControlProps extends FollowUpIdentity {
  /** Override for tests; defaults to the same-origin HTTP adapter. */
  adapter?: SendAdapter;
}

export type FollowUpPhase = "idle" | "sending" | "done";

/**
 * Owner-facing copy for a send outcome. Accepted/queued describe queuing
 * only; only the explicit native duplicate proof mentions suppression.
 */
export function followUpStatusCopy(result: SendResult): string {
  if (result.duplicateSuppressed) {
    return "T3 already held this message under the same request id; no second message was created.";
  }
  switch (result.outcome) {
    case "accepted":
      return "T3 accepted the follow-up message.";
    case "queued":
      return "T3 queued the follow-up message; it has not run yet.";
    case "rejected":
      return result.detail;
    case "ambiguous":
      return result.detail;
  }
}

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

export function FollowUpControl({ connectionId, projectId, threadId, threadTitle, adapter }: FollowUpControlProps) {
  const resolvedAdapter = useMemo(() => adapter ?? createSendAdapter(), [adapter]);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<FollowUpPhase>("idle");
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<SendError | null>(null);
  // One key per composed message. A ref (not state): the key must survive the
  // sending render without itself triggering one, and must NOT change across
  // retries of the same message.
  const requestIdRef = useRef<string | null>(null);

  const handleMessageChange = (next: string) => {
    setMessage(next);
    // An edited message is a new message: fresh key, previous result cleared.
    requestIdRef.current = null;
    setResult(null);
    setError(null);
    setPhase("idle");
  };

  const runSend = async () => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || phase === "sending") return;
    if (requestIdRef.current === null) requestIdRef.current = mintClientRequestId();
    const clientRequestId = requestIdRef.current;
    setPhase("sending");
    setError(null);
    try {
      const outcome = await resolvedAdapter.send({ connectionId, projectId, threadId, message: trimmed, clientRequestId });
      setResult(outcome);
      setPhase("done");
    } catch (thrown) {
      setError(toSendError(thrown));
      setResult(null);
      setPhase("done");
    }
  };

  return (
    <FollowUpView
      connectionId={connectionId}
      projectId={projectId}
      threadId={threadId}
      threadTitle={threadTitle}
      message={message}
      phase={phase}
      result={result}
      error={error}
      onMessageChange={handleMessageChange}
      onSend={() => void runSend()}
      onRetry={() => void runSend()}
    />
  );
}
