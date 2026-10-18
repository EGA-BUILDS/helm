"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { LinearIssueDetail } from "../linear/issues";
import {
  allAdvertisedModels,
  buildFinalPayload,
  clearAllDrafts,
  composeExecutionPrompt,
  draftKey,
  getDraft,
  isModelAdvertised,
  setDraft,
  type FinalPayload,
} from "./prompt";
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
            Reviewed — launch is D07&apos;s job; nothing was launched.
          </p>
        )}
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
}

type ExecuteAction =
  | { type: "preflight/start" }
  | { type: "preflight/ready"; verdict: PreflightVerdict }
  | { type: "preflight/failed"; error: PreflightError }
  | { type: "review/restore"; review: ExecuteReviewState }
  | { type: "review/set"; review: ExecuteReviewState }
  | { type: "review/confirm" };

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
      return { ...state, confirmed: false, review: action.review };
    case "review/confirm":
      return { ...state, confirmed: true };
  }
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
      // Draft retention: navigating away unmounts this panel; the
      // module-level store outlives it, so the lazy initializer restores
      // the edited draft on return.
      review: getDraft(init.key) ?? initialReviewFor(init.issue, "", ""),
    }),
  );
  const { verdict, preflightError, preflightLoading, confirmed, review } = state;
  const reviewRef = useRef(review);

  useEffect(() => {
    // A remount with a different issue identity restores that issue's draft.
    const saved = getDraft(key);
    if (saved) dispatch({ type: "review/restore", review: { ...saved } });
  }, [key]);

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
        // Review-only surface: confirming records intent for D07 and launches
        // nothing — no T3 thread, no worktree, no Linear write.
        dispatch({ type: "review/confirm" });
      }}
    />
  );
}

/** Test hook: reset module-level drafts between isolated tests. */
export function __clearExecuteDraftsForTests(): void {
  clearAllDrafts();
}
