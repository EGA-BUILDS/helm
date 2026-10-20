"use client";

/**
 * Needs-attention badge for one selected native T3 thread (EGA-765).
 *
 * Integration-owned: kept out of the shared Dashboard/controller so the feature
 * lanes could not edit the shared surface concurrently.
 *
 * Read-only projection. It never interrupts, never acknowledges a pending
 * request, and never deletes anything. The state comes from the server's
 * attention read, which derives it from real native evidence and returns
 * `unknown` when that evidence is unavailable — so this component can never
 * manufacture a confident label on its own.
 *
 * Identity safety: the displayed result is keyed by the exact
 * connection/project/thread that produced it. Changing selection therefore shows
 * a loading state immediately (derived during render, not by a synchronous
 * state write in an effect) and a late response for the previous thread can
 * never be rendered against the new one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createInterruptAdapter, type AttentionResult, type InterruptAdapter, toInterruptError } from "./interrupt";

export interface AttentionBadgeProps {
  connectionId: string;
  projectId: string;
  threadId: string;
  adapter?: InterruptAdapter;
}

type Load =
  | { status: "ready"; result: AttentionResult }
  | { status: "error"; message: string };

const LABEL: Record<AttentionResult["state"], string> = {
  needs_attention: "Needs attention",
  running: "Running",
  idle: "Idle",
  unknown: "Attention state unknown",
};

export function AttentionBadge({ connectionId, projectId, threadId, adapter }: AttentionBadgeProps) {
  const identity = useMemo(
    () => `${connectionId}\u0000${projectId}\u0000${threadId}`,
    [connectionId, projectId, threadId],
  );
  /** The result AND the identity it describes, so staleness is structural. */
  const [settled, setSettled] = useState<{ identity: string; load: Load } | null>(null);
  const adapterRef = useRef<InterruptAdapter | null>(adapter ?? null);
  if (adapterRef.current === null) adapterRef.current = createInterruptAdapter();

  useEffect(() => {
    if (!connectionId || !projectId || !threadId) return;
    const controller = new AbortController();
    adapterRef
      .current!.attention({ connectionId, projectId, threadId }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSettled({ identity, load: { status: "ready", result } });
      })
      .catch((raw: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ identity, load: { status: "error", message: toInterruptError(raw).message } });
      });
    return () => controller.abort();
  }, [identity, connectionId, projectId, threadId]);

  if (!connectionId || !projectId || !threadId) return null;

  // Derived, not stored: a settled result for a DIFFERENT identity reads as
  // loading, so a stale receipt is never attributed to the new selection.
  const load: Load | null = settled && settled.identity === identity ? settled.load : null;

  if (load === null) {
    return <p className="help" role="status">Reading native attention state…</p>;
  }
  if (load.status === "error") {
    return <p className="help" role="status">Attention state unavailable. {load.message}</p>;
  }

  const { state, basis, observedAt, t3Reference } = load.result;
  return (
    <div role="status" aria-live="polite">
      <p>
        <strong>{LABEL[state]}</strong>
        {state === "unknown" ? "" : ` · last observed ${observedAt}`}
      </p>
      <p className="help">{basis}</p>
      {/* Owner action stays in T3: Helm has no approval-response capability. */}
      {(state === "needs_attention" || state === "unknown") && <p className="help">{t3Reference}</p>}
    </div>
  );
}
