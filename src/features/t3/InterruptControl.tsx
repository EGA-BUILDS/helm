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
 * click. The confirmation is bound to the selection it was armed against:
 * when `connectionId`, `projectId`, `threadId`, `runId` or `runStatus`
 * changes, the armed confirmation is discarded and the click-time guard
 * refuses to dispatch a stale one, so one confirmation can never fire
 * against a different run. Every outcome is reported honestly — `requested`
 * is never described as verified termination — with the last-observed
 * timestamp and the T3 reference whenever the owner must act elsewhere.
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

export interface ConfirmationTarget {
  connectionId: string;
  projectId: string;
  threadId: string;
  runId: string;
  runStatus: string | null;
}

/** True when the two selections are not the same target cell-for-cell. */
export function confirmationTargetChanged(prev: ConfirmationTarget, next: ConfirmationTarget): boolean {
  return (
    prev.connectionId !== next.connectionId ||
    prev.projectId !== next.projectId ||
    prev.threadId !== next.threadId ||
    prev.runId !== next.runId ||
    prev.runStatus !== next.runStatus
  );
}

export type ConfirmStep =
  | { action: "discard" }
  | {
      action: "submit";
      input: {
        connectionId: string;
        projectId: string;
        threadId: string;
        runId: string;
        clientRequestId?: string;
      };
    };

/**
 * The pure click-time decision for the confirming step. A confirmation only
 * dispatches when it was armed against EXACTLY the current selection; if any
 * identity field moved after arming, the click is discarded — a stale
 * confirmation cannot construct an interrupt input for the previous run.
 */
export function resolveConfirmClick(
  armedFor: ConfirmationTarget | null,
  current: ConfirmationTarget,
  clientRequestId?: string,
): ConfirmStep {
  if (armedFor === null || confirmationTargetChanged(armedFor, current)) {
    return { action: "discard" };
  }
  return {
    action: "submit",
    input: {
      connectionId: current.connectionId,
      projectId: current.projectId,
      threadId: current.threadId,
      runId: current.runId,
      ...(clientRequestId === undefined ? {} : { clientRequestId }),
    },
  };
}

type Phase = "idle" | "armed" | "submitting" | "done" | "failed";

/** Pure status copy so the honest-state wording is unit tested without a DOM. */
export function interruptStatusCopy(
  outcome: InterruptResult["outcome"],
  reason: InterruptResult["reason"] = null,
): { heading: string; note: string } {
  switch (outcome) {
    case "requested":
      return {
        heading: "Interrupt requested",
        note: "Accepted by T3, not verified as terminated.",
      };
    case "already_terminal":
      if (reason === "inflight_interrupt") {
        return {
          heading: "Interrupt already requested",
          note: "Requested, not verified as terminated: the run has not settled. No second interrupt was issued.",
        };
      }
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
      if (reason === "dispatch_outcome_unknown") {
        return {
          heading: "Unclear result",
          note: "The interrupt was sent, but whether it was applied could not be confirmed. No retry was issued.",
        };
      }
      return {
        heading: "Unclear result",
        note: "No retry was issued.",
      };
  }
}

function statusHeading(result: InterruptResult): string {
  return interruptStatusCopy(result.outcome, result.reason).heading;
}

function statusExplanation(result: InterruptResult): string {
  if (result.outcome === "requested") {
    // Requested means requested: T3 accepted the interrupt, which is not the
    // same claim as the run having terminated.
    return "T3 accepted the interrupt request. This does not mean the run has terminated — re-read the thread to confirm.";
  }
  return result.detail;
}

/** Presentational result block, so the honest wording is testable without a DOM. */
export function InterruptResultView({ result }: { result: InterruptResult }) {
  return (
    <div>
      <p>
        <strong>{statusHeading(result)}</strong> — {statusExplanation(result)}
      </p>
      <p>Last observed {result.observedAt}.</p>
      {result.t3Reference ? <p>{result.t3Reference}</p> : null}
    </div>
  );
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
  const current: ConfirmationTarget = { connectionId, projectId, threadId, runId, runStatus };
  const [phase, setPhase] = useState<Phase>("idle");
  /** The selection the armed confirmation was made against; null when unarmed. */
  const [armedFor, setArmedFor] = useState<ConfirmationTarget | null>(null);
  const [result, setResult] = useState<InterruptResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The selections the pending result / failure were produced against. */
  const [resultFor, setResultFor] = useState<ConfirmationTarget | null>(null);
  const [failureFor, setFailureFor] = useState<ConfirmationTarget | null>(null);
  /** The selection last rendered, so a change can be detected during render. */
  const [seen, setSeen] = useState<ConfirmationTarget>(current);
  const effectiveAdapter = adapter ?? createInterruptAdapter();

  // A confirmation is perishable: any selection change (connection, project,
  // thread, run, or the last-observed run status) discards the armed state,
  // the pending result and any failure, so the confirming click always speaks
  // for the selection currently displayed. React's derived-state pattern:
  // reset synchronously DURING render, so a stale confirmation never even
  // commits to the next screen.
  if (confirmationTargetChanged(seen, current)) {
    setSeen(current);
    setArmedFor(null);
    setPhase("idle");
    setFailure(null);
    setResult(null);
    setResultFor(null);
    setFailureFor(null);
  }

  async function confirm() {
    // Belt-and-braces guard: even if a stale armed state somehow survives the
    // render-time reset, the click cannot construct an interrupt input for a
    // selection other than the one the owner confirmed.
    const step = resolveConfirmClick(
      armedFor,
      current,
      typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : undefined,
    );
    if (step.action === "discard") {
      setArmedFor(null);
      setPhase("idle");
      return;
    }
    const armedTarget = { ...armedFor! };
    setPhase("submitting");
    setFailure(null);
    try {
      const issued = await effectiveAdapter.interrupt(step.input);
      setResult(issued);
      setResultFor(armedTarget);
      setPhase("done");
      onDone?.(issued);
    } catch (error) {
      setFailure(toInterruptError(error).message);
      setFailureFor(armedTarget);
      setPhase("failed");
    }
  }

  const confirmationCurrent = armedFor !== null && !confirmationTargetChanged(armedFor, current);
  const resultCurrent = resultFor !== null && !confirmationTargetChanged(resultFor, current);
  const failureCurrent = failureFor !== null && !confirmationTargetChanged(failureFor, current);

  return (
    <section aria-label="Interrupt native run">
      <h3>Interrupt run</h3>
      <p>
        Thread {threadId}
        {runStatus ? ` — last observed run status: ${runStatus}` : ""}. Interrupting never deletes a worktree or a
        thread.
      </p>
      {phase === "idle" ? (
        <button
          type="button"
          onClick={() => {
            setArmedFor({ ...current });
            setPhase("armed");
          }}
        >
          Interrupt
        </button>
      ) : null}
      {phase === "armed" && confirmationCurrent ? (
        <div>
          <p>
            Confirm interrupting run {armedFor?.runId}? This asks T3 to stop the running turn. It cannot be undone from
            here.
          </p>
          <button type="button" onClick={() => void confirm()}>
            Confirm interrupt
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setArmedFor(null);
              setPhase("idle");
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {phase === "submitting" ? <p>Requesting interrupt…</p> : null}
      {phase === "failed" && failureCurrent ? (
        <div>
          <p>Interrupt failed: {failure ?? "The native interrupt could not be completed."}</p>
          <button type="button" onClick={() => setPhase("idle")}>
            Back
          </button>
        </div>
      ) : null}
      {phase === "done" && result && resultCurrent ? (
        <div>
          <InterruptResultView result={result} />
          <button type="button" onClick={() => setPhase("idle")}>
            Back
          </button>
        </div>
      ) : null}
    </section>
  );
}
