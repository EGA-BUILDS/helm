"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { LinearIssueDetail } from "../linear/issues";
import {
  allAdvertisedModels,
  buildFinalPayload,
  clearAllAttemptRecords,
  clearAllDrafts,
  clearAttemptRecord,
  composeExecutionPrompt,
  draftKey,
  getDraft,
  isModelAdvertised,
  setAttemptRecord,
  setDraft,
  type FinalPayload,
} from "./prompt";
import {
  createLaunchAdapter,
  toLaunchError,
  type LaunchError,
  type LaunchOutcome,
  type LaunchResult,
} from "./launch";
import {
  chooseAttemptIdForLaunch,
  recoveryLaunchGate,
  type AttemptRecovery,
} from "./recovery";
import {
  createPreflightAdapter,
  toPreflightError,
  type PreflightError,
  type PreflightVerdict,
} from "./preflight";

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const buttonClass = "rounded-lg border px-3 py-2 text-sm";

export const SUBAGENT_NOTE =
  "Note: this preference is not enforced by Helm — it is passed as a prompt / native input preference only, not a separate Helm orchestration architecture.";

export interface ExecutePanelProps {
  issue: LinearIssueDetail;
  linearProjectId: string;
  linearTeamId: string;
}

export interface ExecuteReviewState {
  prompt: string;
  providerInstanceId: string;
  model: string;
  useSubagents: boolean;
  subagentModel: string | null;
}

export interface ExecuteReviewViewProps {
  issue: LinearIssueDetail;
  verdict: PreflightVerdict | null;
  preflightError: PreflightError | null;
  preflightLoading: boolean;
  review: ExecuteReviewState;
  selectionError: string | null;
  payload: FinalPayload | null;
  payloadText: string | null;
  executeDisabled: boolean;
  confirmed: boolean;
  onReview: (next: ExecuteReviewState) => void;
  onConfirm: () => void;
  /**
   * Explicit native launch (EGA-681 D07). Launching is never ambient: the
   * button below is the only trigger, and it stays disabled with an
   * actionable reason until the review is confirmed and the exact payload
   * shown above is launchable.
   */
  launchDisabled: boolean;
  launchDisabledReason: string | null;
  launching: boolean;
  launchResult: LaunchResult | null;
  launchError: LaunchError | null;
  onLaunch: () => void;
  /**
   * Server-sourced attempt history (Convex is the source of truth). Fresh
   * mounts fetch this instead of trusting module-level browser storage, so
   * a hard reload can never mint a fresh attemptId behind an unresolved
   * server-side attempt. All props below are optional so existing review
   * surfaces render unchanged without recovery data.
   */
  attemptRecovery?: AttemptRecovery | null;
  recoveryLoading?: boolean;
  recoveryError?: string | null;
  onRefreshRecovery?: () => void;
  newExecutionArmed?: boolean;
  onStartNewExecution?: () => void;
  onCancelNewExecution?: () => void;
  onRetryStoredAttempt?: () => void;
  retryDisabled?: boolean;
}

export function initialReviewFor(
  issue: LinearIssueDetail,
  worktreeBaseRef: string,
  targetBranch: string,
): ExecuteReviewState {
  return {
    prompt: composeExecutionPrompt({
      issue: {
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        description: issue.description,
        acceptanceCriteria: issue.acceptanceCriteria,
      },
      worktreeBaseRef,
      targetBranch,
    }).prompt,
    providerInstanceId: "",
    model: "",
    useSubagents: false,
    subagentModel: null,
  };
}

function providerOptions(verdict: PreflightVerdict | null) {
  return verdict?.catalog?.providers ?? [];
}

function modelsForProvider(verdict: PreflightVerdict | null, providerInstanceId: string) {
  return (
    providerOptions(verdict).find((p) => p.providerInstanceId === providerInstanceId)?.models ?? []
  );
}

export function ExecuteReviewView(props: ExecuteReviewViewProps) {
  const {
    issue,
    verdict,
    preflightError,
    preflightLoading,
    review,
    selectionError,
    payload,
    payloadText,
    executeDisabled,
    confirmed,
    onReview,
    onConfirm,
    launchDisabled,
    launchDisabledReason,
    launching,
    launchResult,
    launchError,
    onLaunch,
    attemptRecovery = null,
    recoveryLoading = false,
    recoveryError = null,
    onRefreshRecovery,
    newExecutionArmed = false,
    onStartNewExecution,
    onCancelNewExecution,
    onRetryStoredAttempt,
    retryDisabled = true,
  } = props;
  const providers = providerOptions(verdict);
  const models = modelsForProvider(verdict, review.providerInstanceId);
  const subagentChoices = allAdvertisedModels(verdict?.catalog ?? null);
  const set = (patch: Partial<ExecuteReviewState>) => onReview({ ...review, ...patch });

  return (
    <div className="w-full max-w-3xl rounded-2xl border bg-white p-8 shadow-sm">
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
        Execution review
      </p>
      <h2 className="mt-3 text-2xl font-semibold">Review the exact task prompt</h2>
      <p className="mt-2 text-slate-600">
        Before starting a thread, the owner reviews the exact task prompt, the T3
        model, the subagent preference, the target branch, and the permission
        mode. This surface launches nothing.
      </p>

      {preflightLoading && (
        <p className="mt-2 text-sm text-slate-600" role="status">
          Checking the execution preflight…
        </p>
      )}
      {preflightError && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {preflightError.message}
        </p>
      )}
      {verdict && verdict.blockers.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
          <p className="text-sm font-semibold text-red-800">Execute is disabled:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
            {verdict.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mt-6 text-lg font-semibold">Issue</h3>
      <p className="mt-1 text-sm text-slate-700">
        {issue.identifier} — {issue.title}
      </p>

      <h3 className="mt-6 text-lg font-semibold">
        <label htmlFor="execute-prompt">Exact task prompt (editable)</label>
      </h3>
      <textarea
        id="execute-prompt"
        className={`${inputClass} mt-2 min-h-64 font-mono text-xs`}
        value={review.prompt}
        onChange={(event) => set({ prompt: event.target.value })}
        spellCheck={false}
      />

      <h3 className="mt-6 text-lg font-semibold">Model</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Provider</span>
          <span className="mt-1 block">
            <select
              className={inputClass}
              value={review.providerInstanceId}
              onChange={(event) =>
                set({ providerInstanceId: event.target.value, model: "" })
              }
            >
              <option value="">Select a provider…</option>
              {providers.map((provider) => (
                <option key={provider.providerInstanceId} value={provider.providerInstanceId}>
                  {provider.displayName ?? provider.providerInstanceId}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Model</span>
          <span className="mt-1 block">
            <select
              className={inputClass}
              value={review.model}
              onChange={(event) => set({ model: event.target.value })}
            >
              <option value="">Select a model…</option>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label ?? entry.id}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      <h3 className="mt-6 text-lg font-semibold">Subagents</h3>
      <div className="mt-2 flex items-center gap-4 text-sm" role="radiogroup" aria-label="Use subagents">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="execute-subagents"
            checked={!review.useSubagents}
            onChange={() => set({ useSubagents: false, subagentModel: null })}
          />
          No
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="execute-subagents"
            checked={review.useSubagents}
            onChange={() => set({ useSubagents: true })}
          />
          Yes
        </label>
      </div>
      <p className="mt-1 text-xs text-slate-500">{SUBAGENT_NOTE}</p>
      {review.useSubagents && (
        <label className="mt-3 block text-sm">
          <span className="font-medium text-slate-700">Preferred subagent model</span>
          <span className="mt-1 block">
            <select
              className={inputClass}
              value={review.subagentModel ?? ""}
              onChange={(event) => set({ subagentModel: event.target.value || null })}
            >
              <option value="">Select a subagent model…</option>
              {subagentChoices.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </span>
        </label>
      )}
      {selectionError && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {selectionError}
        </p>
      )}

      <h3 className="mt-6 text-lg font-semibold">Destination</h3>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">T3 project: </dt>
          <dd className="inline">{verdict?.t3ProjectTitle ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">T3 project id: </dt>
          <dd className="inline">{verdict?.t3ProjectId ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">T3 connection id: </dt>
          <dd className="inline">{verdict?.t3ConnectionId ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Worktree intent (base ref): </dt>
          <dd className="inline">{verdict?.worktreeBaseRef ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">PR target branch: </dt>
          <dd className="inline">{verdict?.targetBranch ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Permission mode: </dt>
          <dd className="inline">{verdict?.catalog?.runtimeMode ?? "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium">Catalog freshness: </dt>
          <dd className="inline">
            {verdict?.catalog
              ? `${verdict.catalog.providers.length} providers, observed ${verdict.catalog.freshness.observedAt}, ${verdict.catalog.freshness.stale ? "stale" : "fresh"}`
              : "—"}
          </dd>
        </div>
      </dl>

      <h3 className="mt-6 text-lg font-semibold">Exact final payload</h3>
      {payloadText && payload ? (
        <pre className="mt-2 overflow-auto rounded-xl border bg-slate-50 p-4 font-mono text-xs text-slate-800">
          {payloadText}
        </pre>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          The final payload appears once a provider, model, and prompt are selected.
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} disabled={executeDisabled} onClick={onConfirm}>
          Execute
        </button>
        {confirmed && (
          <p className="text-sm text-slate-600" role="status">
            Reviewed — launching is a separate explicit step below; nothing was launched.
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-slate-200 pt-6">
        <h3 className="text-lg font-semibold">Native launch</h3>
        <p className="mt-1 text-sm text-slate-600">
          Launches exactly the payload shown above as one native T3 worktree thread.
          This button is the only trigger — reviewing never launches.
        </p>
        {launchDisabledReason && (
          <p className="mt-2 text-sm text-slate-600" role="status">
            {launchDisabledReason}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className={buttonClass} disabled={launchDisabled} onClick={onLaunch}>
            {launching ? "Launching…" : "Launch thread"}
          </button>
        </div>
        {launchResult && (
          <div
            className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"
            role="status"
          >
            <p className="font-medium text-slate-800">Launch {launchResult.outcome}</p>
            <p className="mt-1 text-slate-600">{launchResult.detail}</p>
            {launchResult.threadId && (
              <p className="mt-1 font-mono text-xs text-slate-700">Thread {launchResult.threadId}</p>
            )}
            {launchResult.outcome !== "launched" && launchResult.reason && (
              <p className="mt-1 text-xs text-slate-500">Reason: {launchResult.reason}</p>
            )}
          </div>
        )}
        {launchError && (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {launchError.message}
          </p>
        )}
        <div className="mt-6 border-t border-slate-200 pt-6">
          <h3 className="text-lg font-semibold">Prior executions</h3>
          <p className="mt-1 text-sm text-slate-600">
            Read from the server on every mount, so a browser reload recovers the
            recorded attempt instead of starting a second one.
          </p>
          {recoveryLoading && (
            <p className="mt-2 text-sm text-slate-600" role="status">
              Checking prior executions…
            </p>
          )}
          {recoveryError && (
            <div className="mt-2" role="alert">
              <p className="text-sm text-red-700">{recoveryError}</p>
              {onRefreshRecovery && (
                <button type="button" className={`${buttonClass} mt-2`} onClick={onRefreshRecovery}>
                  Refresh prior executions
                </button>
              )}
            </div>
          )}
          {!recoveryLoading && !recoveryError && attemptRecovery?.outcome === "none" && (
            <p className="mt-2 text-sm text-slate-600" role="status">
              No prior executions for this issue.
            </p>
          )}
          {!recoveryLoading && !recoveryError && attemptRecovery && attemptRecovery.outcome !== "none" && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm" role="status">
              {attemptRecovery.outcome === "acknowledged" && (
                <>
                  <p className="font-medium text-slate-800">Already launched</p>
                  {attemptRecovery.latest?.threadId && (
                    <p className="mt-1 font-mono text-xs text-slate-700">
                      Thread {attemptRecovery.latest.threadId}
                    </p>
                  )}
                  <p className="mt-1 text-slate-600">
                    Attempt {attemptRecovery.latest?.attemptId} carries the confirmed thread.
                    A new execution needs a separately confirmed start.
                  </p>
                  {onStartNewExecution &&
                    (newExecutionArmed ? (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button type="button" className={buttonClass} onClick={onStartNewExecution}>
                          Confirm new execution
                        </button>
                        {onCancelNewExecution && (
                          <button type="button" className={buttonClass} onClick={onCancelNewExecution}>
                            Keep existing thread
                          </button>
                        )}
                      </div>
                    ) : (
                      <button type="button" className={`${buttonClass} mt-3`} onClick={onStartNewExecution}>
                        Start a new execution
                      </button>
                    ))}
                </>
              )}
              {attemptRecovery.outcome === "abandoned" && (
                <>
                  <p className="font-medium text-slate-800">Prior attempt abandoned</p>
                  <p className="mt-1 text-slate-600">
                    Attempt {attemptRecovery.latest?.attemptId} was abandoned by an operator;
                    a new execution will start fresh.
                  </p>
                </>
              )}
              {attemptRecovery.outcome === "unresolved" && (
                <>
                  <p className="font-medium text-slate-800">
                    Prior attempt {attemptRecovery.latest?.state}
                  </p>
                  <p className="mt-1 text-slate-600">
                    Attempt {attemptRecovery.latest?.attemptId} has not settled; launching is
                    disabled and nothing was relaunched.
                  </p>
                  {attemptRecovery.blockers.map((blocker) => (
                    <p key={blocker} className="mt-1 text-slate-600">
                      {blocker}
                    </p>
                  ))}
                  {onRetryStoredAttempt && (
                    <button
                      type="button"
                      className={`${buttonClass} mt-3`}
                      disabled={retryDisabled}
                      onClick={onRetryStoredAttempt}
                    >
                      Retry attempt {attemptRecovery.latest?.attemptId}
                    </button>
                  )}
                </>
              )}
              {attemptRecovery.outcome === "ambiguous" && (
                <>
                  <p className="font-medium text-slate-800">Prior attempt ambiguous</p>
                  <p className="mt-1 text-slate-600">
                    Attempt {attemptRecovery.latest?.attemptId} could not be resolved to one
                    thread; launching is disabled and no relaunch was issued.
                  </p>
                  {attemptRecovery.blockers.map((blocker) => (
                    <p key={blocker} className="mt-1 text-slate-600">
                      {blocker}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ExecuteState {
  verdict: PreflightVerdict | null;
  preflightError: PreflightError | null;
  preflightLoading: boolean;
  confirmed: boolean;
  review: ExecuteReviewState;
  launching: boolean;
  launchResult: LaunchResult | null;
  launchError: LaunchError | null;
  attemptRecovery: AttemptRecovery | null;
  recoveryLoading: boolean;
  recoveryError: string | null;
  newExecutionArmed: boolean;
}

type ExecuteAction =
  | { type: "preflight/start" }
  | { type: "preflight/ready"; verdict: PreflightVerdict }
  | { type: "preflight/failed"; error: PreflightError }
  | { type: "review/restore"; review: ExecuteReviewState }
  | { type: "review/set"; review: ExecuteReviewState }
  | { type: "review/confirm" }
  | { type: "launch/start" }
  | { type: "launch/ready"; result: LaunchResult }
  | { type: "launch/failed"; error: LaunchError }
  | { type: "recovery/reset" }
  | { type: "recovery/refresh" }
  | { type: "recovery/ready"; recovery: AttemptRecovery }
  | { type: "recovery/failed"; error: string }
  | { type: "newExecution/arm" }
  | { type: "newExecution/cancel" };

function executeReducer(state: ExecuteState, action: ExecuteAction): ExecuteState {
  switch (action.type) {
    case "preflight/start":
      return { ...state, preflightLoading: true, preflightError: null };
    case "preflight/ready":
      return { ...state, preflightLoading: false, verdict: action.verdict };
    case "preflight/failed":
      return { ...state, preflightLoading: false, verdict: null, preflightError: action.error };
    case "review/restore":
      return { ...state, review: action.review };
    case "review/set":
      // A new edit invalidates any previous launch outcome: the payload the
      // owner launches must be byte-identical to the payload shown.
      return { ...state, confirmed: false, review: action.review, launchResult: null, launchError: null };
    case "review/confirm":
      return { ...state, confirmed: true };
    case "launch/start":
      return { ...state, launching: true, launchResult: null, launchError: null };
    case "launch/ready":
      return { ...state, launching: false, launchResult: action.result, newExecutionArmed: false };
    case "launch/failed":
      return { ...state, launching: false, launchError: action.error };
    case "recovery/reset":
      // A new issue/mapping identity starts from no server knowledge and no
      // armed execution: the next fetch is the source of truth.
      return {
        ...state,
        attemptRecovery: null,
        recoveryLoading: true,
        recoveryError: null,
        newExecutionArmed: false,
      };
    case "recovery/refresh":
      return { ...state, recoveryLoading: true, recoveryError: null };
    case "recovery/ready":
      return { ...state, recoveryLoading: false, recoveryError: null, attemptRecovery: action.recovery };
    case "recovery/failed":
      return { ...state, recoveryLoading: false, recoveryError: action.error };
    case "newExecution/arm":
      return { ...state, newExecutionArmed: true, launchResult: null, launchError: null };
    case "newExecution/cancel":
      return { ...state, newExecutionArmed: false };
  }
}

export interface LaunchGateInput {
  confirmed: boolean;
  launching: boolean;
  recoveryLoading: boolean;
  recoveryError: string | null;
  /** Null while the preflight verdict is still loading. */
  verdictBlockers: string[] | null;
  selectionError: string | null;
  hasPayload: boolean;
  useSubagents: boolean;
  recovery: AttemptRecovery | null;
  newExecutionArmed: boolean;
  launchOutcome: LaunchOutcome | null;
}

/**
 * Pure launch-availability rule for the execute panel, exported for tests.
 * The server's recovery gates every decision: while it is pending or failed
 * the panel fails closed, because launching without knowing the recorded
 * attempt would reintroduce both attempt-identity defects (a reload minting a
 * fresh id behind an unresolved attempt; a settled thread pinning the issue).
 */
export function describeLaunchDisabledReason(input: LaunchGateInput): string | null {
  if (!input.confirmed) return "Confirm the review above first.";
  if (input.launching) return "Launching…";
  if (input.recoveryLoading) return "Checking prior executions…";
  if (input.recoveryError !== null) {
    return "Prior execution state could not be verified; refresh below before launching.";
  }
  if (input.verdictBlockers !== null && input.verdictBlockers.length > 0) {
    return "Resolve the blockers above first.";
  }
  if (input.selectionError !== null || !input.hasPayload) {
    return input.selectionError ?? "Resolve the review above first.";
  }
  if (input.useSubagents) {
    return "Switch subagents off to launch; the native launch cannot forward a subagent preference yet.";
  }
  if (input.recovery) {
    const gate = recoveryLaunchGate(input.recovery, { newExecutionArmed: input.newExecutionArmed });
    if (gate) return gate.reason;
  }
  if (input.launchOutcome === "launched") {
    return "Already launched — a new execution needs a fresh review.";
  }
  return null;
}

export function ExecutePanel(props: ExecutePanelProps) {
  const { issue, linearProjectId, linearTeamId } = props;
  const key = draftKey(linearProjectId, linearTeamId, issue.id);
  const [state, dispatch] = useReducer(
    executeReducer,
    { issue, key },
    (init: { issue: LinearIssueDetail; key: string }): ExecuteState => ({
      verdict: null,
      preflightError: null,
      preflightLoading: true,
      confirmed: false,
      launching: false,
      launchResult: null,
      launchError: null,
      attemptRecovery: null,
      recoveryLoading: true,
      recoveryError: null,
      newExecutionArmed: false,
      // Draft retention: navigating away unmounts this panel; the
      // module-level store outlives it, so the lazy initializer restores
      // the edited draft on return.
      review: getDraft(init.key) ?? initialReviewFor(init.issue, "", ""),
    }),
  );
  const {
    verdict,
    preflightError,
    preflightLoading,
    confirmed,
    review,
    launching,
    launchResult,
    launchError,
    attemptRecovery,
    recoveryLoading,
    recoveryError,
    newExecutionArmed,
  } = state;
  const reviewRef = useRef(review);
  const mountedRef = useRef(true);
  /**
   * Synchronous in-flight guard. `launching` state only disables the button on
   * the NEXT render; two clicks dispatched in the same task both see the
   * pre-update closure and would each POST a different attemptId. The server
   * refuses the loser (stale precondition), but the client must not send it.
   */
  const launchingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // A remount with a different issue identity restores that issue's draft.
    const saved = getDraft(key);
    if (saved) dispatch({ type: "review/restore", review: { ...saved } });
  }, [key]);

  useEffect(() => {
    // Server-sourced attempt history (Convex is the source of truth). A fresh
    // mount — including after a full browser reload, when module-level
    // browser storage is empty — recovers the recorded attempt instead of
    // minting a fresh id. This effect never launches: it only reads.
    dispatch({ type: "recovery/reset" });
    const controller = new AbortController();
    createLaunchAdapter()
      .recover({ linearProjectId, linearTeamId, linearIssueId: issue.id }, controller.signal)
      .then((recovery) => {
        if (controller.signal.aborted) return;
        if (mountedRef.current) dispatch({ type: "recovery/ready", recovery });
      })
      .catch((thrown) => {
        if (controller.signal.aborted) return;
        if (thrown instanceof DOMException && thrown.name === "AbortError") return;
        if (mountedRef.current) {
          dispatch({ type: "recovery/failed", error: toLaunchError(thrown).message });
        }
      });
    return () => controller.abort();
  }, [linearProjectId, linearTeamId, issue.id, key]);

  useEffect(() => {
    reviewRef.current = review;
    setDraft(key, { ...review });
  }, [key, review]);

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "preflight/start" });
    createPreflightAdapter()
      .checkPreflight({ linearProjectId, linearTeamId }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "preflight/ready", verdict: result });
        // Fill the prompt template's refs once the destination is known,
        // but never clobber an owner edit: only a draft still byte-identical
        // to the unfilled template is replaced.
        const saved = getDraft(key);
        const unfilled = initialReviewFor(issue, "", "").prompt;
        const current = saved?.prompt ?? reviewRef.current;
        if (current === unfilled) {
          const filled = initialReviewFor(
            issue,
            result.worktreeBaseRef ?? "",
            result.targetBranch ?? "",
          );
          dispatch({ type: "review/set", review: { ...filled, providerInstanceId: "", model: "", useSubagents: false, subagentModel: null } });
        } else if (saved) {
          dispatch({ type: "review/restore", review: { ...saved } });
        }
      })
      .catch((thrown) => {
        if (controller.signal.aborted) return;
        if (thrown instanceof DOMException && thrown.name === "AbortError") return;
        dispatch({ type: "preflight/failed", error: toPreflightError(thrown) });
      });
    return () => controller.abort();
  }, [linearProjectId, linearTeamId, key, issue]);

  const selectionError = useMemo(() => {
    if (!verdict) return null;
    if (verdict.blockers.length > 0) return null;
    if (!review.providerInstanceId || !review.model) {
      return "Choose a T3-advertised provider and model.";
    }
    if (!isModelAdvertised(verdict.catalog, review.providerInstanceId, review.model)) {
      return "That model is not in the live T3 catalog; pick an advertised one.";
    }
    if (review.useSubagents && !review.subagentModel) {
      return "Choose a preferred subagent model or switch subagents off.";
    }
    if (
      review.useSubagents &&
      review.subagentModel &&
      !allAdvertisedModels(verdict.catalog).includes(review.subagentModel)
    ) {
      return "That subagent model is not in the live T3 catalog; pick an advertised one.";
    }
    if (!review.prompt) return "The task prompt must not be empty.";
    return null;
  }, [verdict, review]);

  const payload: FinalPayload | null = useMemo(() => {
    if (!verdict || verdict.blockers.length > 0 || selectionError) return null;
    try {
      return buildFinalPayload({
        prompt: review.prompt,
        providerInstanceId: review.providerInstanceId,
        model: review.model,
        useSubagents: review.useSubagents,
        subagentModel: review.subagentModel,
        worktreeBaseRef: verdict.worktreeBaseRef ?? "",
        targetBranch: verdict.targetBranch ?? "",
        runtimeMode: verdict.catalog?.runtimeMode ?? "supervised",
      });
    } catch {
      return null;
    }
  }, [verdict, review, selectionError]);

  const payloadText = payload ? JSON.stringify(payload, null, 2) : null;
  const executeDisabled =
    preflightLoading || !verdict || verdict.blockers.length > 0 || selectionError !== null || payload === null;

  const launchDisabledReason = describeLaunchDisabledReason({
    confirmed,
    launching,
    recoveryLoading,
    recoveryError,
    verdictBlockers: verdict ? verdict.blockers : null,
    selectionError,
    hasPayload: payload !== null,
    useSubagents: review.useSubagents,
    recovery: attemptRecovery,
    newExecutionArmed,
    launchOutcome: launchResult?.outcome ?? null,
  });
  const launchDisabled = launchDisabledReason !== null;

  // An explicit retry of an UNRESOLVED attempt adopts the server's attemptId
  // so `prepareLaunchAttempt` returns `reused: true`. It is the only path
  // that reuses an id; every new execution mints a fresh one. Never ambient:
  // only this button triggers it.
  const retryDisabled =
    launching ||
    !confirmed ||
    !payload ||
    !verdict ||
    verdict.blockers.length > 0 ||
    selectionError !== null ||
    review.useSubagents ||
    !attemptRecovery ||
    attemptRecovery.outcome !== "unresolved" ||
    attemptRecovery.latest === null;

  const finishLaunch = (result: LaunchResult) => {
    launchingRef.current = false;
    if (mountedRef.current) dispatch({ type: "launch/ready", result });
    if (result.outcome === "launched") {
      // An acknowledged launch must not pin the issue key to the old attempt:
      // the record is a convenience, and the next execution mints fresh.
      clearAttemptRecord(key);
    }
    // The server is the source of truth: re-read the recorded attempt after
    // every launch so the panel shows what actually happened.
    refreshRecovery();
  };

  /**
   * A `stale_recovery` failure means the issue changed since this tab last
   * recovered (a stale tab minting a fresh attemptId behind a settled
   * attempt). Re-run recovery so the panel shows the refreshed server state,
   * disarm the two-step new-execution control so the owner must decide
   * again, and never auto-retry the launch.
   */
  const handleStaleRecovery = (message: string) => {
    if (mountedRef.current) {
      dispatch({ type: "launch/failed", error: { code: "stale_recovery", message, retryable: false } });
      dispatch({ type: "newExecution/cancel" });
    }
    refreshRecovery();
  };

  const refreshRecovery = () => {
    const controller = new AbortController();
    dispatch({ type: "recovery/refresh" });
    createLaunchAdapter()
      .recover({ linearProjectId, linearTeamId, linearIssueId: issue.id }, controller.signal)
      .then((recovery) => {
        if (controller.signal.aborted) return;
        if (mountedRef.current) dispatch({ type: "recovery/ready", recovery });
      })
      .catch((thrown) => {
        if (controller.signal.aborted) return;
        if (thrown instanceof DOMException && thrown.name === "AbortError") return;
        if (mountedRef.current) {
          dispatch({ type: "recovery/failed", error: toLaunchError(thrown).message });
        }
      });
  };

  const handleLaunch = () => {
    if (launchDisabled || !payload || !verdict || launchingRef.current) return;
    launchingRef.current = true;
    // A new execution always mints a fresh attemptId — and this button is
    // only enabled when the server allows it (`canStartNewExecution`). The
    // local record is written as a convenience only; nothing reads it to
    // decide what the server may do. The reservation carries the
    // precondition token from this tab's last successful recovery, so a
    // stale tab cannot slip past a settled attempt.
    const attemptId = crypto.randomUUID();
    setAttemptRecord(key, { attemptId });
    dispatch({ type: "launch/start" });
    createLaunchAdapter()
      .launch({
        attemptId,
        linearProjectId,
        linearTeamId,
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        prompt: payload.prompt,
        providerInstanceId: payload.providerInstanceId,
        model: payload.model,
        runtimeMode: payload.runtimeMode,
        useSubagents: payload.useSubagents,
        subagentModel: payload.subagentModel,
        expectedLatestAttemptId: attemptRecovery?.observedLatestAttemptId ?? null,
      })
      .then(finishLaunch)
      .catch((thrown) => {
        launchingRef.current = false;
        const failure = toLaunchError(thrown);
        if (failure.code === "stale_recovery") {
          handleStaleRecovery(failure.message);
          return;
        }
        if (mountedRef.current) dispatch({ type: "launch/failed", error: failure });
      });
  };

  const handleRetryStoredAttempt = () => {
    if (retryDisabled || !payload || !verdict || launchingRef.current) return;
    launchingRef.current = true;
    // Adopt the SERVER's attemptId, never a new one: the retry hits the same
    // reservation (`reused: true`) instead of colliding with it. The token
    // travels with it; a retry of the same reservation does not need a
    // current token because it creates nothing new.
    const attemptId = chooseAttemptIdForLaunch({
      recovery: attemptRecovery,
      retryStoredAttempt: true,
      mint: () => crypto.randomUUID(),
    });
    setAttemptRecord(key, { attemptId });
    dispatch({ type: "launch/start" });
    createLaunchAdapter()
      .launch({
        attemptId,
        linearProjectId,
        linearTeamId,
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        prompt: payload.prompt,
        providerInstanceId: payload.providerInstanceId,
        model: payload.model,
        runtimeMode: payload.runtimeMode,
        useSubagents: payload.useSubagents,
        subagentModel: payload.subagentModel,
        expectedLatestAttemptId: attemptRecovery?.observedLatestAttemptId ?? null,
      })
      .then(finishLaunch)
      .catch((thrown) => {
        launchingRef.current = false;
        const failure = toLaunchError(thrown);
        if (failure.code === "stale_recovery") {
          handleStaleRecovery(failure.message);
          return;
        }
        if (mountedRef.current) dispatch({ type: "launch/failed", error: failure });
      });
  };

  const handleStartNewExecution = () => {
    if (!attemptRecovery || !attemptRecovery.canStartNewExecution || launching) return;
    if (!newExecutionArmed) {
      dispatch({ type: "newExecution/arm" });
      return;
    }
    // Separately confirmed: forget the acknowledged attempt locally so the
    // next explicit launch mints a genuinely fresh attemptId.
    clearAttemptRecord(key);
    dispatch({ type: "newExecution/arm" });
  };

  return (
    <ExecuteReviewView
      issue={issue}
      verdict={verdict}
      preflightError={preflightError}
      preflightLoading={preflightLoading}
      review={review}
      selectionError={selectionError}
      payload={payload}
      payloadText={payloadText}
      executeDisabled={executeDisabled}
      confirmed={confirmed}
      onReview={(next) => {
        dispatch({ type: "review/set", review: next });
      }}
      onConfirm={() => {
        // Review-only surface: confirming records intent and unlocks the
        // explicit launch step below; it launches nothing itself.
        dispatch({ type: "review/confirm" });
      }}
      launchDisabled={launchDisabled}
      launchDisabledReason={launchDisabledReason}
      launching={launching}
      launchResult={launchResult}
      launchError={launchError}
      onLaunch={handleLaunch}
      attemptRecovery={attemptRecovery}
      recoveryLoading={recoveryLoading}
      recoveryError={recoveryError}
      onRefreshRecovery={refreshRecovery}
      newExecutionArmed={newExecutionArmed}
      onStartNewExecution={handleStartNewExecution}
      onCancelNewExecution={() => dispatch({ type: "newExecution/cancel" })}
      onRetryStoredAttempt={handleRetryStoredAttempt}
      retryDisabled={retryDisabled}
    />
  );
}

/** Test hook: reset module-level drafts and attempt records between isolated tests. */
export function __clearExecuteDraftsForTests(): void {
  clearAllDrafts();
  clearAllAttemptRecords();
}
