"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import {
  createLinearMappingsAdapter,
  toMappingError,
  type MappingError,
  type ProjectMapping,
} from "./mappings";
import {
  createLinearIssuesAdapter,
  toIssueError,
  type BrowseIssuesInput,
  type IssueError,
  type IssuesPage,
  type LinearIssue,
  type LinearIssueDetail,
} from "./issues";

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const buttonClass = "rounded-lg border px-3 py-2 text-sm";

/** State types Linear reports. The unfinished default excludes by type, never by state name. */
const STATE_TYPE_OPTIONS = ["backlog", "unstarted", "started", "completed", "canceled", "triage"] as const;
const PRIORITY_OPTIONS = [
  { value: "", label: "Any priority" },
  { value: "0", label: "No priority (0)" },
  { value: "1", label: "Urgent (1)" },
  { value: "2", label: "High (2)" },
  { value: "3", label: "Medium (3)" },
  { value: "4", label: "Low (4)" },
] as const;

export interface IssueFilters {
  projectId: string;
  includeCompleted: boolean;
  stateType: string;
  priority: string;
  assigneeId: string;
  text: string;
}

export function emptyFilters(): IssueFilters {
  return { projectId: "", includeCompleted: false, stateType: "", priority: "", assigneeId: "", text: "" };
}

/** Merge a newly loaded page without duplicating rows already on screen. */
export function mergeIssues(previous: LinearIssue[], next: LinearIssue[]): LinearIssue[] {
  if (previous.length === 0) return next;
  const seen = new Set(previous.map((item) => item.id));
  return [...previous, ...next.filter((item) => !seen.has(item.id))];
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

function IssueMeta({ label, value }: { label: string; value: string }) {
  return <div><dt className="inline font-medium">{label}: </dt><dd className="inline">{value}</dd></div>;
}

export function issueListSummary(page: IssuesPage | null, loaded: number): string | null {
  if (!page) return null;
  if (page.items.length === 0 && loaded === 0) return null;
  const scope = page.filtersEcho.textScope === "loaded-page" && page.filtersEcho.text
    ? ` Text “${page.filtersEcho.text}” narrows the loaded pages only.`
    : "";
  const more = page.nextCursor !== null ? " More pages may exist upstream." : " End of the loaded pages.";
  return `${loaded} matching issues in the loaded pages.${scope}${more}`;
}

export interface IssuesBrowserViewProps {
  data: IssuesPage | null;
  filters: IssueFilters;
  mappings: ProjectMapping[] | null;
  mappingsError: MappingError | null;
  detail: { issue: LinearIssueDetail; stale: boolean } | null;
  notice: string | null;
  error: IssueError | null;
  loading: boolean;
  loadingMore: boolean;
  detailLoading: boolean;
  detailError: IssueError | null;
  onFilters: (filters: IssueFilters) => void;
  onSelectIssue: (issue: LinearIssue) => void;
  onLoadMore: () => void;
}

export function IssuesBrowserView(props: IssuesBrowserViewProps) {
  const { data, filters, mappings, mappingsError, detail } = props;
  const { notice, error, loading, loadingMore, detailLoading, detailError } = props;
  const { onFilters, onSelectIssue, onLoadMore } = props;
  const enabled = (mappings ?? []).filter((mapping) => mapping.enabled);
  const set = (patch: Partial<IssueFilters>) => onFilters({ ...filters, ...patch });
  const summary = issueListSummary(data, data?.items.length ?? 0);

  return (
    <div className="w-full max-w-3xl rounded-2xl border bg-white p-8 shadow-sm">
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">Linear issues</p>
      <h2 className="mt-3 text-2xl font-semibold">Issue browser</h2>
      <p className="mt-2 text-slate-600">
        Browse genuine Linear issues from every enabled mapped project. Linear stays the
        source of truth: this surface only reads.
      </p>
      {data && data.errors.length > 0 && (
        <p className="mt-4 text-sm text-amber-700" role="alert">
          Linear reported {data.errors.length === 1 ? "an error" : "errors"} alongside this page: {data.errors.join(" ")} The
          list below may be partial.
        </p>
      )}

      <h3 className="mt-6 text-lg font-semibold">Filters</h3>
      {mappingsError && <p className="mt-2 text-sm text-red-700" role="alert">{mappingsError.message}</p>}
      {mappings === null && !mappingsError && <p className="mt-2 text-sm text-slate-600" role="status">Loading mapped projects…</p>}
      {mappings !== null && enabled.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">No enabled mapped projects. Map a Linear project first.</p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Mapped project">
          <select
            className={inputClass} value={filters.projectId}
            onChange={(event) => set({ projectId: event.target.value })}
          >
            <option value="">Select a mapped project…</option>
            {enabled.map((mapping) => (
              <option key={`${mapping.linearProjectId}:${mapping.linearTeamId}`} value={mapping.linearProjectId}>
                {mapping.linearProjectName} · {mapping.linearTeamKey}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State type" hint="Empty means every state the unfinished filter allows.">
          <select className={inputClass} value={filters.stateType} onChange={(event) => set({ stateType: event.target.value })}>
            <option value="">Any state</option>
            {STATE_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputClass} value={filters.priority} onChange={(event) => set({ priority: event.target.value })}>
            {PRIORITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <Field label="Assignee id" hint="Exact Linear user id. Empty means anyone.">
          <input
            className={inputClass} type="text" value={filters.assigneeId} autoComplete="off" spellCheck={false}
            placeholder="e.g. 9cfb482a-…" onChange={(event) => set({ assigneeId: event.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Text search" hint="Narrows the loaded pages only — identifier, title and description.">
            <input
              className={inputClass} type="search" value={filters.text} autoComplete="off" spellCheck={false}
              placeholder="Search the loaded pages…" onChange={(event) => set({ text: event.target.value })}
            />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <input
          id="linear-include-completed" type="checkbox" checked={filters.includeCompleted}
          onChange={(event) => set({ includeCompleted: event.target.checked })}
        />
        <label htmlFor="linear-include-completed">Show completed and canceled issues (unfinished only by default)</label>
      </div>

      <h3 className="mt-8 text-lg font-semibold">Issues</h3>
      {loading && <p className="mt-2 text-sm text-slate-600" role="status">Reading Linear issues…</p>}
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error.message}</p>}
      {notice && <p className="mt-2 text-sm text-slate-600" role="status">{notice}</p>}
      {summary && <p className="mt-2 text-xs text-slate-500" role="status">{summary}</p>}
      {data !== null && data.items.length === 0 && !loading && !error && (
        <p className="mt-2 text-sm text-slate-600">No issues match these filters. Nothing was invented: Linear returned an empty page.</p>
      )}
      {data !== null && data.items.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.items.map((issue) => (
            <li key={issue.id} className="rounded-xl border p-4">
              <p className="font-medium">{issue.identifier} — {issue.title}</p>
              <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-slate-600 sm:grid-cols-2">
                <IssueMeta label="Team" value={`${issue.team.key} · ${issue.team.name}`} />
                <IssueMeta label="Status" value={`${issue.state.name} (${issue.state.type})`} />
                <IssueMeta label="Priority" value={`${issue.priorityLabel} (${issue.priority})`} />
                <IssueMeta label="Assignee" value={issue.assignee ? issue.assignee.name : "Unassigned"} />
                <IssueMeta label="Updated" value={issue.updatedAt} />
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => onSelectIssue(issue)}>Show detail</button>
                <a className={buttonClass} href={issue.url} target="_blank" rel="noreferrer">Open in Linear ↗</a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data?.nextCursor !== null && data !== null && (
        <div className="mt-4">
          <button type="button" className={buttonClass} disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading more…" : "Load more issues"}
          </button>
        </div>
      )}

      <h3 className="mt-8 text-lg font-semibold">Selected issue</h3>
      {detailLoading && <p className="mt-2 text-sm text-slate-600" role="status">Reading the issue detail…</p>}
      {detailError && <p className="mt-2 text-sm text-red-700" role="alert">{detailError.message}</p>}
      {!detail && !detailLoading && !detailError && (
        <p className="mt-2 text-sm text-slate-600">Select an issue to read its full context.</p>
      )}
      {detail && (
        <article className="mt-3 rounded-xl border p-4">
          <p className="font-medium">{detail.issue.identifier} — {detail.issue.title}</p>
          {detail.stale && (
            <p className="mt-1 text-xs text-amber-700" role="status">The filters changed while this detail was loading; it may belong to an older selection.</p>
          )}
          <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-slate-600 sm:grid-cols-2">
            <IssueMeta label="Team" value={`${detail.issue.team.key} · ${detail.issue.team.name}`} />
            <IssueMeta label="Status" value={`${detail.issue.state.name} (${detail.issue.state.type})`} />
            <IssueMeta label="Priority" value={`${detail.issue.priorityLabel} (${detail.issue.priority})`} />
            <IssueMeta label="Assignee" value={detail.issue.assignee ? detail.issue.assignee.name : "Unassigned"} />
            <IssueMeta label="Updated" value={detail.issue.updatedAt} />
            <IssueMeta label="Created" value={detail.issue.createdAt} />
          </dl>
          <h4 className="mt-4 font-semibold">Description</h4>
          {detail.issue.description ? (
            <pre className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{detail.issue.description}</pre>
          ) : (
            <p className="mt-1 text-sm text-slate-600">No description on this issue.</p>
          )}
          <h4 className="mt-4 font-semibold">Acceptance criteria</h4>
          {detail.issue.acceptanceCriteria ? (
            <pre className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{detail.issue.acceptanceCriteria}</pre>
          ) : (
            <p className="mt-1 text-sm text-slate-600">This issue lists no acceptance criteria.</p>
          )}
          <div className="mt-3">
            <a className={buttonClass} href={detail.issue.url} target="_blank" rel="noreferrer">Open in Linear ↗</a>
          </div>
        </article>
      )}
    </div>
  );
}

function toBrowseInput(filters: IssueFilters, cursor: string | null): BrowseIssuesInput | null {
  if (!filters.projectId) return null;
  return {
    projectId: filters.projectId,
    ...(filters.includeCompleted ? { includeCompleted: true as const } : {}),
    ...(filters.stateType ? { stateType: filters.stateType } : {}),
    ...(filters.priority !== "" ? { priority: Number(filters.priority) } : {}),
    ...(filters.assigneeId.trim() ? { assigneeId: filters.assigneeId.trim() } : {}),
    ...(filters.text.trim() ? { text: filters.text.trim() } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 25,
  };
}

interface BrowserState {
  page: IssuesPage | null;
  notice: string | null;
  error: IssueError | null;
  loading: boolean;
  loadingMore: boolean;
  detail: { issue: LinearIssueDetail; stale: boolean } | null;
  detailLoading: boolean;
  detailError: IssueError | null;
}

const initialBrowserState: BrowserState = {
  page: null,
  notice: "Select a mapped project to browse its issues.",
  error: null,
  loading: false,
  loadingMore: false,
  detail: null,
  detailLoading: false,
  detailError: null,
};

type BrowserAction =
  | { type: "browse/start"; scope: number }
  | { type: "browse/ready"; scope: number; page: IssuesPage }
  | { type: "browse/failed"; scope: number; error: IssueError }
  | { type: "browse/cleared" }
  | { type: "more/start" }
  | { type: "more/ready"; scope: number; page: IssuesPage }
  | { type: "more/failed"; scope: number; error: IssueError }
  | { type: "more/finished" }
  | { type: "detail/start" }
  | { type: "detail/ready"; scope: number; stale: boolean; issue: LinearIssueDetail }
  | { type: "detail/failed"; scope: number; error: IssueError }
  | { type: "detail/finished" };

/**
 * Pure read-state core for the Linear issue browser, mirroring the T3
 * dashboard idiom: every transition lives here, and stale scopes are dropped
 * by comparing the action's scope against the current one instead of merging.
 */
export function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case "browse/start":
      return { ...state, loading: true, error: null, detail: null, detailError: null, page: null };
    case "browse/ready":
      return { ...state, loading: false, page: action.page, notice: null, error: null };
    case "browse/failed":
      return { ...state, loading: false, page: null, error: action.error };
    case "browse/cleared":
      return {
        ...initialBrowserState,
        notice: "Select a mapped project to browse its issues.",
      };
    case "more/start":
      return { ...state, loadingMore: true };
    case "more/ready": {
      const current = state.page;
      return {
        ...state,
        loadingMore: false,
        page: current === null ? action.page : {
          ...action.page,
          items: mergeIssues(current.items, action.page.items),
          errors: [...current.errors, ...action.page.errors],
        },
      };
    }
    case "more/failed":
      return { ...state, loadingMore: false, error: action.error };
    case "more/finished":
      return state.loadingMore ? { ...state, loadingMore: false } : state;
    case "detail/start":
      return { ...state, detailLoading: true, detailError: null };
    case "detail/ready":
      return { ...state, detailLoading: false, detail: { issue: action.issue, stale: action.stale } };
    case "detail/failed":
      return { ...state, detailLoading: false, detail: null, detailError: action.error };
    case "detail/finished":
      return state.detailLoading ? { ...state, detailLoading: false } : state;
  }
}

export function LinearIssueBrowser() {
  const [mappings, setMappings] = useState<ProjectMapping[] | null>(null);
  const [mappingsError, setMappingsError] = useState<MappingError | null>(null);
  const [filters, setFilters] = useState<IssueFilters>(emptyFilters());
  const [textInput, setTextInput] = useState("");
  const [state, dispatch] = useReducer(browserReducer, initialBrowserState);
  /** Monotonic scope: a response from an older filter selection is dropped, never merged. */
  const scope = useRef(0);
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The visible text field debounces into the applied filters, mirroring the
  // T3 dashboard's debounced thread query so typing never fans out one read
  // per keystroke.
  useEffect(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      setFilters((current) => (current.text === textInput ? current : { ...current, text: textInput }));
    }, 300);
    return () => { if (textTimer.current) clearTimeout(textTimer.current); };
  }, [textInput]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    createLinearMappingsAdapter().listMappings(controller.signal)
      .then((rows) => {
        if (!active) return;
        setMappings(rows);
        const first = rows.find((row) => row.enabled) ?? null;
        if (first) setFilters((current) => (current.projectId ? current : { ...current, projectId: first.linearProjectId }));
      })
      .catch((thrown) => { if (active) setMappingsError(toMappingError(thrown)); });
    return () => { active = false; controller.abort(); };
  }, []);

  useEffect(() => {
    const input = toBrowseInput(filters, null);
    // No project selected: the view already derives its empty state from the
    // null page during render, so there is nothing to synchronize here.
    if (!input) return;
    const requestScope = (scope.current += 1);
    const controller = new AbortController();
    dispatch({ type: "browse/start", scope: requestScope });
    createLinearIssuesAdapter().browseIssues(input, controller.signal)
      .then((page) => {
        if (requestScope !== scope.current || controller.signal.aborted) return;
        dispatch({ type: "browse/ready", scope: requestScope, page });
      })
      .catch((thrown) => {
        if (requestScope !== scope.current || controller.signal.aborted) return;
        dispatch({ type: "browse/failed", scope: requestScope, error: toIssueError(thrown) });
      });
    return () => controller.abort();
  }, [filters]);

  async function handleLoadMore() {
    const cursor = state.page?.nextCursor ?? null;
    const input = toBrowseInput(filters, cursor);
    if (!input || !cursor || state.loadingMore) return;
    const requestScope = scope.current;
    dispatch({ type: "more/start" });
    try {
      const page = await createLinearIssuesAdapter().browseIssues(input);
      if (requestScope !== scope.current) return;
      dispatch({ type: "more/ready", scope: requestScope, page });
    } catch (thrown) {
      if (requestScope !== scope.current) return;
      dispatch({ type: "more/failed", scope: requestScope, error: toIssueError(thrown) });
    } finally {
      if (requestScope === scope.current) dispatch({ type: "more/finished" });
    }
  }

  async function handleSelectIssue(issue: LinearIssue) {
    const requestScope = scope.current;
    dispatch({ type: "detail/start" });
    try {
      const read = await createLinearIssuesAdapter().readIssue(filters.projectId, issue.id);
      // The owner moving on mid-read surfaces the detail as stale rather
      // than silently presenting it as current.
      dispatch({
        type: "detail/ready",
        scope: requestScope,
        stale: requestScope !== scope.current,
        issue: read.issue,
      });
    } catch (thrown) {
      if (requestScope !== scope.current) return;
      dispatch({ type: "detail/failed", scope: requestScope, error: toIssueError(thrown) });
    } finally {
      if (requestScope === scope.current) dispatch({ type: "detail/finished" });
    }
  }

  /** Filter changes are owner events, so dependent reads reset here — never inside an effect. */
  function handleFilters(next: IssueFilters) {
    setTextInput(next.text);
    setFilters(next);
    if (!next.projectId) dispatch({ type: "browse/cleared" });
  }

  return (
    <IssuesBrowserView
      data={state.page}
      filters={{ ...filters, text: textInput }}
      mappings={mappings}
      mappingsError={mappingsError}
      detail={state.detail}
      notice={state.notice}
      error={state.error}
      loading={state.loading}
      loadingMore={state.loadingMore}
      detailLoading={state.detailLoading}
      detailError={state.detailError}
      onFilters={handleFilters}
      onSelectIssue={(issue) => void handleSelectIssue(issue)}
      onLoadMore={() => void handleLoadMore()}
    />
  );
}
