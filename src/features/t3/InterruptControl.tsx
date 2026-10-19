import { useState } from "react";
import {
  createInterruptAdapter,
  toInterruptError,
  type AttentionResult,
  type InterruptAdapter,
  type InterruptResult,
} from "./interrupt";

/**
 * Self-contained native interrupt control (EGA-765 v0.2 D11).
 *
 * Deliberately NOT wired into the shared dashboard controller: it takes the
 * thread+run identity as props and posts only through the same-origin
 * interrupt route when the owner explicitly confirms. Nothing here launches,
 * sends, deletes a worktree, or deletes a thread.
 *
 * Two steps, always: the first click only arms the control ("Confirm
 * interrupt"); the destructive POST happens only on the second, explicit
 * click. Every outcome is reported honestly — `requested` is never described
 * as verified termination — with the last-observed timestamp and the T3
 * reference whenever the owner must act elsewhere.
 */

export interface InterruptControlProps {
  connectionId: string;
  projectId: string;
  threadId: string;
  runId: string;
  /** Latest natively observed run status, shown for context; never a fresh read. */
  runStatus?: string | null;
  adapter?: InterruptAdapter;
  onDone?: (result: InterruptResult) => void;
}

type Phase = "idle" | "armed" | "submitting" | "done" | "failed";

function statusHeading(result: InterruptResult): string {
  switch (result.outcome) {
    case "requested":
      return "Interrupt requested";
    case "already_terminal":
      return "Already terminal";
    case "no_active_run":
      return "No active run";
    case "rejected":
      return "Not interrupted";
    case "ambiguous":
      return "Unclear result";
  }
}

function statusExplanation(result: InterruptResult): string {
  if (result.outcome === "requested") {
    // Requested means requested: T3 accepted the interrupt, which is not the
    // same claim as the run having terminated.
    return "T3 accepted the interrupt request. This does not mean the run has terminated — re-read the thread to confirm.";
  }
  return result.detail;
}

/** Pure status copy so the honest-state wording is unit tested without a DOM. */
export function interruptStatusCopy(outcome: InterruptResult["outcome"]): { heading: string; note: string } {
  switch (outcome) {
    case "requested":
      return {
        heading: "Interrupt requested",
        note: "Accepted by T3, not verified as terminated.",
      };
    case "already_terminal":
      return {
        heading: "Already terminal",
        note: "No second interrupt was issued.",
      };
    case "no_active_run":
      return {
        heading: "No active run",
        note: "Nothing was interrupted and nothing was deleted.",
      };
    case "rejected":
      return {
        heading: "Not interrupted",
        note: "Refused before any interrupt call.",
      };
    case "ambiguous":
      return {
        heading: "Unclear result",
        note: "No retry was issued.",
      };
  }
}

export function InterruptAttentionLine({ attention }: { attention: AttentionResult | null }) {
  if (!attention) return null;
  return (
    <p>
      <span>Attention: {attention.state.replace(/_/gu, " ")}.</span> <span>{attention.basis}</span>{" "}
      <span>Observed {attention.observedAt}.</span> <span>{attention.t3Reference}</span>
    </p>
  );
}

export function InterruptControl({
  connectionId,
  projectId,
  threadId,
  runId,
  runStatus = null,
  adapter,
  onDone,
}: InterruptControlProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<InterruptResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const effectiveAdapter = adapter ?? createInterruptAdapter();

  async function confirm() {
    setPhase("submitting");
    setFailure(null);
    try {
      const issued = await effectiveAdapter.interrupt({
        connectionId,
        projectId,
        threadId,
        runId,
        clientRequestId:
          typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : undefined,
      });
      setResult(issued);
      setPhase("done");
      onDone?.(issued);
    } catch (error) {
      setFailure(toInterruptError(error).message);
      setPhase("failed");
    }
  }

  return (
    <section aria-label="Interrupt native run">
      <h3>Interrupt run</h3>
      <p>
        Thread {threadId}
        {runStatus ? ` — last observed run status: ${runStatus}` : ""}. Interrupting never deletes a worktree or a
        thread.
      </p>
      {phase === "idle" ? (
        <button type="button" onClick={() => setPhase("armed")}>
          Interrupt
        </button>
      ) : null}
      {phase === "armed" ? (
        <div>
          <p>
            Confirm interrupting run {runId}? This asks T3 to stop the running turn. It cannot be undone from here.
          </p>
          <button type="button" onClick={() => void confirm()}>
            Confirm interrupt
          </button>{" "}
          <button type="button" onClick={() => setPhase("idle")}>
            Cancel
          </button>
        </div>
      ) : null}
      {phase === "submitting" ? <p>Requesting interrupt…</p> : null}
      {phase === "failed" ? (
        <div>
          <p>Interrupt failed: {failure ?? "The native interrupt could not be completed."}</p>
          <button type="button" onClick={() => setPhase("idle")}>
            Back
          </button>
        </div>
      ) : null}
      {phase === "done" && result ? (
        <div>
          <p>
            <strong>{statusHeading(result)}</strong> — {statusExplanation(result)}
          </p>
          <p>Last observed {result.observedAt}.</p>
          {result.t3Reference ? <p>{result.t3Reference}</p> : null}
          <button type="button" onClick={() => setPhase("idle")}>
            Back
          </button>
        </div>
      ) : null}
    </section>
  );
}
