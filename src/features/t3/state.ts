/**
 * Pure state core for the live T3 dashboard.
 *
 * Every rule that is easy to get subtly wrong lives here rather than inside a
 * React effect: scope invalidation when a selection changes, deduplicating page
 * concatenation, incremental activity merging, and dropping responses that
 * belong to a selection the owner has already moved away from.
 *
 * `useT3Dashboard` is a thin binding over this reducer.
 */

import {
  threadDetailKey,
  threadIdentity,
  projectScopeKey,
  type AccessLevel,
  type Activity,
  type Catalog,
  type ConnectedEnvironment,
  type ConnectionRecord,
  type ConnectionState,
  type DashboardData,
  type Environment,
  type Freshness,
  type Page,
  type Project,
  type ReadState,
  type Thread,
  type ThreadDetail,
  type ThreadRun,
  type UiError,
} from "./contract";

export type Resource = "projects" | "threads" | "activity";
export type BusyPhase = "starting" | "refreshing" | "disconnecting";

const unavailable = { status: "unavailable" } as const;

/**
 * Owner-facing freshness for the selected thread's incremental activity read.
 *
 * `lastObservedAt` is only written after a successful read, so a timer tick or
 * a failed request can never be presented as a successful heartbeat. The
 * identity fields make a late response from an old selection harmless even
 * before React has torn the old effect down.
 */
export interface ActivityRefreshState {
  readonly connectionId: string | null;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly lastObservedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly error: UiError | null;
  readonly consecutiveFailures: number;
  /** A non-retryable failure stopped the loop; no timer is scheduled. */
  readonly terminal: boolean;
}

export const idleActivityRefresh: ActivityRefreshState = {
  connectionId: null,
  projectId: null,
  threadId: null,
  lastObservedAt: null,
  lastAttemptAt: null,
  error: null,
  consecutiveFailures: 0,
  terminal: false,
};

/** Freshness for the slower cross-project summary loop. */
export interface SummaryRefreshState {
  readonly lastAttemptAt: string | null;
  readonly lastObservedAt: string | null;
  readonly error: UiError | null;
  readonly consecutiveFailures: number;
  readonly terminal: boolean;
}

export const idleSummaryRefresh: SummaryRefreshState = {
  lastAttemptAt: null,
  lastObservedAt: null,
  error: null,
  consecutiveFailures: 0,
  terminal: false,
};

export interface ControllerState {
  readonly inventory: ReadState<readonly ConnectionRecord[]>;
  /** When Helm last observed the inventory; upstream reports no snapshot time. */
  readonly inventoryObservedAt: string | null;
  /** The in-flight consent flow outcome; only used when no connection is usable. */
  readonly oauth: ConnectionState;
  readonly environment: ReadState<Environment | null>;
  readonly catalog: ReadState<Catalog>;
  readonly projects: ReadState<Page<Project>>;
  readonly threads: ReadState<Page<Thread>>;
  /** "selected-project" keeps the v0.1 single-project experience; "all-projects" aggregates every loaded project. */
  readonly threadView: "selected-project" | "all-projects";
  /** Per-project thread page inventory, keyed by projectScopeKey(connectionId, projectId). */
  readonly threadPages: Readonly<Record<string, ReadState<Page<Thread>>>>;
  readonly detail: ReadState<ThreadDetail>;
  /** A failed explicit Load more; the already-loaded items and cursor are kept. */
  readonly detailPageError: UiError | null;
  /** True while any selected-thread activity read owns the single slot. */
  readonly activityReadInFlight: boolean;
  /** Last successful incremental read of the selected thread, never a heartbeat guess. */
  readonly activityRefresh: ActivityRefreshState;
  /** Last successful/failed cross-project summary refresh. */
  readonly summaryRefresh: SummaryRefreshState;
  /** Single source of truth for the owner's current selection. */
  readonly connectionId: string | null;
  readonly projectId: string | null;
  /** Detail read for the selected project; independent of the project list. */
  readonly projectDetail: ReadState<Project>;
  readonly threadId: string | null;
  readonly threadProjectId: string | null;
  /**
   * Monotonic token identifying the current thread query scope. Every change of
   * project, query or status bumps it, so a paginated response issued under an
   * older scope can be recognised and dropped instead of being merged into
   * newer, differently filtered data.
   */
  readonly threadScope: number;
  /** Native `t3_thread_list` title filter. Empty means "no server-side filter". */
  readonly threadQuery: string;
  readonly threadStatuses: readonly string[];
  /** Union of statuses seen in loaded pages, so the status filter never shrinks to nothing. */
  readonly observedThreadStatuses: readonly string[];
  readonly busy: BusyPhase | null;
  readonly paging: Readonly<Record<Resource, boolean>>;
  readonly notice: string | null;
  readonly error: UiError | null;
}

export const initialControllerState: ControllerState = {
  inventory: { status: "loading" },
  inventoryObservedAt: null,
  oauth: { status: "not-connected" },
  environment: unavailable,
  catalog: unavailable,
  projects: unavailable,
  threads: unavailable,
  threadView: "selected-project",
  threadPages: {},
  detail: unavailable,
  detailPageError: null,
  activityReadInFlight: false,
  activityRefresh: idleActivityRefresh,
  summaryRefresh: idleSummaryRefresh,
  connectionId: null,
  projectId: null,
  projectDetail: unavailable,
  threadId: null,
  threadProjectId: null,
  threadScope: 0,
  threadQuery: "",
  threadStatuses: [],
  observedThreadStatuses: [],
  busy: null,
  paging: { projects: false, threads: false, activity: false },
  notice: null,
  error: null,
};

const dependentReads = {
  environment: unavailable,
  catalog: unavailable,
  projects: unavailable,
  threads: unavailable,
  threadView: "selected-project",
  threadPages: {},
  detail: unavailable,
  detailPageError: null,
  activityReadInFlight: false,
  activityRefresh: idleActivityRefresh,
  summaryRefresh: idleSummaryRefresh,
} as const;

export type ControllerAction =
  | { type: "inventory/start" }
  | { type: "inventory/ready"; connections: readonly ConnectionRecord[]; observedAt: string; selectAccess?: AccessLevel }
  | { type: "inventory/failed"; error: UiError }
  | { type: "oauth/pending"; expiresAt: string | null }
  | { type: "oauth/denied" }
  | { type: "oauth/expired" }
  | { type: "oauth/reset" }
  | { type: "select/connection"; connectionId: string | null }
  | { type: "select/project"; projectId: string | null }
  | { type: "select/thread"; threadId: string | null; projectId: string | null }
  | { type: "thread/query"; query: string }
  | { type: "thread/statuses"; statuses: readonly string[] }
  | { type: "thread/view"; view: "selected-project" | "all-projects" }
  | { type: "project/detail/loading"; connectionId: string; projectId: string }
  | { type: "project/detail/ready"; connectionId: string; projectId: string; project: Project }
  | { type: "project/detail/failed"; connectionId: string; projectId: string; error: UiError }
  | { type: "environment/loading"; connectionId: string }
  | { type: "environment/ready"; connectionId: string; environment: Environment }
  | { type: "environment/failed"; connectionId: string; error: UiError }
  | { type: "catalog/loading"; connectionId: string }
  | { type: "catalog/ready"; connectionId: string; catalog: Catalog }
  | { type: "catalog/failed"; connectionId: string; error: UiError }
  | { type: "projects/loading"; connectionId: string }
  | { type: "projects/ready"; connectionId: string; page: Page<Project> }
  | { type: "projects/failed"; connectionId: string; error: UiError }
  | { type: "threads/loading"; connectionId: string; projectId: string; scope: number }
  /** `source: "refresh"` is a background summary read: it never clears a load-more busy flag. */
  | { type: "threads/ready"; connectionId: string; projectId: string; scope: number; page: Page<Thread>; source?: "refresh" }
  | { type: "threads/failed"; connectionId: string; projectId: string; scope: number; error: UiError }
  | { type: "detail/loading"; connectionId: string; threadId: string }
  | { type: "detail/ready"; connectionId: string; threadId: string; detail: ThreadDetail }
  | { type: "detail/page"; connectionId: string; threadId: string; detail: ThreadDetail }
  | { type: "detail/refresh-start"; connectionId: string; projectId: string; threadId: string; attemptedAt: string }
  | { type: "detail/refreshed"; connectionId: string; projectId: string; threadId: string; detail: ThreadDetail; attemptedAt: string }
  | { type: "detail/refresh-failed"; connectionId: string; projectId: string; threadId: string; error: UiError; attemptedAt: string }
  | { type: "detail/page-failed"; connectionId: string; projectId: string; threadId: string; error: UiError }
  | { type: "detail/continuation"; connectionId: string; projectId: string; threadId: string; item: Activity }
  | { type: "detail/failed"; connectionId: string; threadId: string; error: UiError; attemptedAt?: string }
  | { type: "activity/in-flight"; active: boolean }
  | { type: "summary/refresh-start"; attemptedAt: string }
  | { type: "summary/refresh-ok"; observedAt: string | null }
  | { type: "summary/refresh-failed"; error: UiError }
  | { type: "busy"; phase: BusyPhase }
  | { type: "idle" }
  | { type: "paging"; resource: Resource; active: boolean }
  | { type: "notice"; message: string | null }
  | { type: "error"; error: UiError | null }
  /** Sign-out, owner-grant loss or a revoked session: drop every private read. */
  | { type: "private/clear" };

/**
 * Appends a page without duplicating rows. Upstream pages are not a stable
 * snapshot, so an item may legitimately repeat across a page boundary.
 */
export function mergePage<T>(previous: Page<T> | null, next: Page<T>, identity: (item: T) => string): Page<T> {
  if (!previous) return next;
  const seen = new Set(previous.items.map(identity));
  const additions = next.items.filter((item) => !seen.has(identity(item)));
  return {
    items: [...previous.items, ...additions],
    nextCursor: next.nextCursor,
    total: next.total,
    freshness: next.freshness,
  };
}

/**
 * Thread-page merge policy.
 *
 * Position is stable: the first page that surfaced an identity owns its row
 * position. Evidence is not frozen: a repeated identity is replaced by newer
 * trustworthy thread evidence. A valid `updatedAt` decides the winner; an
 * unknown timestamp never displaces a known one. When both timestamps are
 * unknown or equal, the later page wins because it is the later observation.
 * The cursor, total and freshness always come from the page just read.
 */
export function mergeThreadPage(previous: Page<Thread> | null, next: Page<Thread>): Page<Thread> {
  if (!previous) return next;
  const positions = new Map(previous.items.map((item, index) => [threadIdentity(item), index]));
  const items = [...previous.items];
  for (const item of next.items) {
    const identity = threadIdentity(item);
    const position = positions.get(identity);
    if (position === undefined) {
      positions.set(identity, items.length);
      items.push(item);
      continue;
    }
    const current = items[position]!;
    const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
    const nextTime = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
    const currentKnown = Number.isFinite(currentTime);
    const nextKnown = Number.isFinite(nextTime);
    if (!currentKnown || (nextKnown && nextTime >= currentTime)) items[position] = item;
  }
  return { items, nextCursor: next.nextCursor, total: next.total, freshness: next.freshness };
}

/** Later items with the same identity win, which is how truncated text is extended. */
export function mergeByIdentity<T>(previous: readonly T[], next: readonly T[], identity: (item: T) => string): T[] {
  const merged = new Map(previous.map((item) => [identity(item), item]));
  for (const item of next) merged.set(identity(item), item);
  return [...merged.values()];
}

export function mergeActivity(previous: readonly Activity[], next: readonly Activity[]): Activity[] {
  return mergeByIdentity(previous, next, (item) => item.id).sort((left, right) => left.position - right.position);
}

function mergeRuns(previous: readonly ThreadRun[], next: readonly ThreadRun[]): ThreadRun[] {
  return mergeByIdentity(previous, next, (run) => run.runId);
}

/** Appends an incremental `t3_thread_read` page without dropping earlier activity. */
export function appendDetail(previous: ThreadDetail, next: ThreadDetail): ThreadDetail {
  return {
    ...next,
    thread: next.thread,
    items: mergeActivity(previous.items, next.items),
    recentRuns: mergeRuns(previous.recentRuns, next.recentRuns),
  };
}

function replaceContinuation(previous: ThreadDetail, item: Activity): ThreadDetail {
  return { ...previous, items: mergeActivity(previous.items, [item]) };
}

type DetailIdentity = { readonly connectionId: string; readonly projectId: string; readonly threadId: string };

/** Full identity check: the same thread id in two projects is not the same thread. */
function detailIdentityMatches(state: ControllerState, identity: DetailIdentity): boolean {
  return state.connectionId === identity.connectionId &&
    state.threadId === identity.threadId &&
    state.threadProjectId === identity.projectId;
}

function activitySuccess(identity: DetailIdentity, observedAt: string | null, attemptedAt: string): ActivityRefreshState {
  return {
    connectionId: identity.connectionId,
    projectId: identity.projectId,
    threadId: identity.threadId,
    lastObservedAt: observedAt,
    lastAttemptAt: attemptedAt,
    error: null,
    consecutiveFailures: 0,
    terminal: false,
  };
}

function activityFailure(
  previous: ActivityRefreshState,
  identity: DetailIdentity,
  error: UiError,
  attemptedAt: string,
): ActivityRefreshState {
  const sameSelection = previous.connectionId === identity.connectionId &&
    previous.projectId === identity.projectId &&
    previous.threadId === identity.threadId;
  return {
    connectionId: identity.connectionId,
    projectId: identity.projectId,
    threadId: identity.threadId,
    // Keep the last real observation. A failed attempt is not a heartbeat.
    lastObservedAt: sameSelection ? previous.lastObservedAt : null,
    lastAttemptAt: attemptedAt,
    error,
    consecutiveFailures: sameSelection ? previous.consecutiveFailures + 1 : 1,
    // A non-retryable failure is terminal: the controller must not schedule a
    // timer, and the UI must not claim it is retrying.
    terminal: !error.retryable,
  };
}

/**
 * Connection state shown to the owner. A saved connection record always wins:
 * a consent outcome never invents a connected state, and a revoked or
 * unreachable connection is never presented as connected.
 */
export function deriveConnectionState(state: ControllerState): ConnectionState {
  // Before an inventory read succeeds, the only authorization signal Helm has
  // is the outcome of the consent flow it just ran. It is never `connected`.
  if (state.inventory.status !== "ready") return state.oauth;
  const connections = state.inventory.data;
  const selected = state.connectionId === null
    ? undefined
    : connections.find((connection) => connection.connectionId === state.connectionId);
  const fallback = connections.find((connection) => connection.status === "connected") ?? connections[0];
  const connection = selected ?? fallback;
  if (!connection || connection.status === "disconnected") return state.oauth;
  switch (connection.status) {
    case "connected":
      return { status: "connected", connection };
    case "revoked":
      return { status: "revoked", connection };
    case "unreachable":
      return { status: "unreachable", connection };
    case "expired":
      return { status: "expired", expiredAt: connection.expiresAt, connection };
  }
}

/** The connection whose reads are currently authorized, or null when none is. */
export function activeConnectionId(state: ControllerState): string | null {
  const derived = deriveConnectionState(state);
  return derived.status === "connected" ? derived.connection.connectionId : null;
}

function scoped(state: ControllerState, connectionId: string): boolean {
  return state.connectionId === connectionId;
}

/** Bounded union of statuses seen so far; upstream only accepts 10 per request. */
function observeStatuses(known: readonly string[], items: readonly Thread[]): readonly string[] {
  const next = new Set(known);
  for (const thread of items) if (thread.status) next.add(thread.status);
  return next.size === known.length ? known : [...next].slice(0, 20);
}

export function controllerReducer(state: ControllerState, action: ControllerAction): ControllerState {
  switch (action.type) {
    case "inventory/start":
      // A refresh keeps the previous inventory on screen instead of flashing a
      // false "not connected" state while the read is in flight.
      return state.inventory.status === "ready" ? state : { ...state, inventory: { status: "loading" } };
    case "inventory/ready": {
      const connections = action.connections;
      // A successful consent may ask for the newly authorized tier to be
      // selected. The hint is honored ONLY when the authenticated inventory
      // contains a connected row of that tier; a forged or stale hint can
      // never select a row that the backend did not verify.
      const hinted = action.selectAccess
        ? connections
          .filter((entry) => entry.status === "connected" && entry.access === action.selectAccess)
          .sort((left, right) =>
            (right.lastVerifiedAt ?? "").localeCompare(left.lastVerifiedAt ?? "") ||
            left.connectionId.localeCompare(right.connectionId))[0]
        : undefined;
      const known = state.connectionId !== null && connections.some((entry) => entry.connectionId === state.connectionId);
      const connectionId = hinted?.connectionId ?? (known
        ? state.connectionId
        : (connections.find((entry) => entry.status === "connected") ?? connections[0])?.connectionId ?? null);
      const changed = connectionId !== state.connectionId;
      // Only a switch AWAY from a previously selected connection can have
      // in-flight scoped reads. The initial selection has none, so it must not
      // consume a scope generation the first project selection expects.
      const switching = changed && state.connectionId !== null;
      // A different selected connection means every scoped read is stale.
      return {
        ...state,
        inventory: { status: "ready", data: connections },
        inventoryObservedAt: action.observedAt,
        connectionId,
        ...(changed ? {
          ...dependentReads,
          projectId: null,
          projectDetail: unavailable,
          threadId: null,
          threadProjectId: null,
          threadScope: switching ? state.threadScope + 1 : state.threadScope,
          threadQuery: "",
          threadStatuses: [],
          observedThreadStatuses: [],
          threadPages: {},
          paging: { ...state.paging, threads: false, activity: false },
        } : {}),
        // A callback failure is owner-facing guidance, not stale inventory
        // state: keep it visible until the owner acts or starts a new consent.
        error: state.error?.code === "callback_failed" ? state.error : null,
      };
    }
    case "inventory/failed":
      return {
        ...state,
        inventory: { status: "error", error: action.error },
        inventoryObservedAt: null,
        ...dependentReads,
        projectId: null,
        projectDetail: unavailable,
        threadScope: state.threadScope + 1,
        threadId: null,
        threadPages: {},
        connectionId: null,
        error: action.error,
      };
    case "oauth/pending":
      return { ...state, oauth: { status: "pending", expiresAt: action.expiresAt }, error: null, notice: null, busy: null };
    case "oauth/denied":
      return { ...state, oauth: { status: "denied" }, busy: null, error: null, notice: "T3 consent was declined. No new access was granted." };
    case "oauth/expired":
      return { ...state, oauth: { status: "expired", expiredAt: null }, busy: null, error: null, notice: "The T3 authorization request expired. Start a new sign-in when ready." };
    case "oauth/reset":
      return { ...state, oauth: { status: "not-connected" }, error: null, notice: null };

    case "select/connection":
      if (action.connectionId === state.connectionId) return state;
      return {
        ...state,
        connectionId: action.connectionId,
        ...dependentReads,
        projectId: null,
        projectDetail: unavailable,
        threadScope: state.threadScope + 1,
        threadId: null,
        threadProjectId: null,
        threadQuery: "",
        threadStatuses: [],
        observedThreadStatuses: [],
        threadPages: {},
        error: null,
      };
    case "select/project":
      if (action.projectId === state.projectId) return state;
      // In the cross-project overview, changing the project merely changes which
      // project's detail is shown. The overview inventory and its local filters
      // belong to no single project, so they must survive.
      if (state.threadView === "all-projects") {
        return {
          ...state,
          projectId: action.projectId,
          projectDetail: unavailable,
          detail: unavailable,
          detailPageError: null,
          activityReadInFlight: false,
          activityRefresh: idleActivityRefresh,
          threadId: null,
          threadProjectId: null,
        };
      }
      // A project change starts a new thread scope. The previous project's
      // server-side filters are not carried over: keeping a stale `titleContains`
      // or status filter would silently hide threads in the new project.
      // Cached pages are dropped too: their rows were fetched under the old
      // project's filters and must never be merged into the new result set.
      return {
        ...state,
        projectId: action.projectId,
        projectDetail: unavailable,
        threads: unavailable,
        detail: unavailable,
        detailPageError: null,
        activityReadInFlight: false,
        activityRefresh: idleActivityRefresh,
        summaryRefresh: idleSummaryRefresh,
        threadId: null,
        threadProjectId: null,
        threadScope: state.threadScope + 1,
        threadQuery: "",
        threadStatuses: [],
        observedThreadStatuses: [],
        threadPages: {},
      };
    case "project/detail/loading":
      return state.connectionId === action.connectionId && state.projectId === action.projectId
        ? { ...state, projectDetail: { status: "loading" } }
        : state;
    // Identity is verified by the transport adapter before it reaches here; the
    // scope check is what stops a superseded project's detail from landing.
    case "project/detail/ready":
      return state.connectionId === action.connectionId && state.projectId === action.projectId
        ? { ...state, projectDetail: { status: "ready", data: action.project } }
        : state;
    case "project/detail/failed":
      return state.connectionId === action.connectionId && state.projectId === action.projectId
        ? { ...state, projectDetail: { status: "error", error: action.error } }
        : state;
    case "select/thread":
      // Selection carries the project so detail can never be attributed to a
      // different project that happens to reuse the same upstream thread ID.
      if (action.threadId === state.threadId && action.projectId === state.threadProjectId) return state;
      return {
        ...state,
        threadId: action.threadId,
        threadProjectId: action.projectId,
        detail: unavailable,
        detailPageError: null,
        activityReadInFlight: false,
        activityRefresh: idleActivityRefresh,
      };
    case "thread/query":
      if (action.query === state.threadQuery) return state;
      // The all-projects view filters its already-loaded rows locally: a
      // keystroke must not fan out a fresh thread read for every project, and a
      // server-side title filter would otherwise silently exclude rows whose
      // status or model matched the owner's search.
      if (state.threadView === "all-projects") return { ...state, threadQuery: action.query };
      return { ...state, threadQuery: action.query, threadScope: state.threadScope + 1, threads: unavailable, detail: unavailable, detailPageError: null, activityReadInFlight: false, activityRefresh: idleActivityRefresh, summaryRefresh: idleSummaryRefresh, threadId: null, threadPages: {}, paging: { ...state.paging, threads: false } };
    case "thread/statuses":
      if (action.statuses.length === state.threadStatuses.length &&
          action.statuses.every((status, index) => status === state.threadStatuses[index])) return state;
      // Same rule as the query: in the cross-project view the filter applies to
      // loaded rows and never changes what a project page means.
      if (state.threadView === "all-projects") return { ...state, threadStatuses: action.statuses };
      return { ...state, threadStatuses: action.statuses, threadScope: state.threadScope + 1, threads: unavailable, detail: unavailable, detailPageError: null, activityReadInFlight: false, activityRefresh: idleActivityRefresh, summaryRefresh: idleSummaryRefresh, threadId: null, threadPages: {}, paging: { ...state.paging, threads: false } };

    case "thread/view": {
      const next = action.view;
      if (next !== "selected-project" && next !== "all-projects") return state;
      if (next === state.threadView) return state;
      // Cached pages were fetched under the other view's server-side filters.
      // Dropping them is what prevents rows from the previous scope being
      // merged into, or counted as part of, the new inventory.
      return {
        ...state,
        threadView: next,
        threads: unavailable,
        threadPages: {},
        summaryRefresh: idleSummaryRefresh,
        threadScope: state.threadScope + 1,
        paging: { ...state.paging, threads: false },
      };
    }

    case "environment/loading":
      return scoped(state, action.connectionId) ? { ...state, environment: { status: "loading" } } : state;
    case "environment/ready":
      return scoped(state, action.connectionId) ? { ...state, environment: { status: "ready", data: action.environment } } : state;
    case "environment/failed":
      return scoped(state, action.connectionId) ? { ...state, environment: { status: "error", error: action.error } } : state;

    case "catalog/loading":
      return scoped(state, action.connectionId) ? { ...state, catalog: { status: "loading" } } : state;
    case "catalog/ready":
      return scoped(state, action.connectionId) ? { ...state, catalog: { status: "ready", data: action.catalog } } : state;
    case "catalog/failed":
      return scoped(state, action.connectionId) ? { ...state, catalog: { status: "error", error: action.error } } : state;

    case "projects/loading":
      return scoped(state, action.connectionId) ? { ...state, projects: { status: "loading" }, paging: { ...state.paging, projects: false } } : state;
    case "projects/ready": {
      if (!scoped(state, action.connectionId)) return state;
      const previous = state.projects.status === "ready" ? state.projects.data : null;
      const mergedProjects = mergePage(previous, action.page, (item) => `${item.connectionId}:${item.projectId}`);
      // Drop per-project thread pages for projects that are no longer present,
      // so a changed project list cannot leave stale thread data behind.
      const known = new Set(mergedProjects.items.map((item) => projectScopeKey(item.connectionId, item.projectId)));
      const nextThreadPages: Record<string, ReadState<Page<Thread>>> = {};
      for (const [key, value] of Object.entries(state.threadPages)) {
        if (known.has(key)) nextThreadPages[key] = value;
      }
      return { ...state, projects: { status: "ready", data: mergedProjects }, threadPages: nextThreadPages, paging: { ...state.paging, projects: false } };
    }
    case "projects/failed":
      return scoped(state, action.connectionId) ? { ...state, projects: { status: "error", error: action.error }, paging: { ...state.paging, projects: false } } : state;

    case "threads/loading": {
      // Accept a load for any project under the live connection/scope, so the
      // all-projects fan-out can track per-project loading state.
      if (state.connectionId !== action.connectionId || state.threadScope !== action.scope) return state;
      const key = projectScopeKey(action.connectionId, action.projectId);
      const nextThreadPages = { ...state.threadPages, [key]: { status: "loading" } as ReadState<Page<Thread>> };
      const selectedLoading = state.threadView === "selected-project" && action.projectId === state.projectId;
      // An overview with no completed page yet must announce loading rather
      // than look like a permanently unavailable read.
      const overviewLoading = state.threadView === "all-projects" && state.threads.status !== "ready";
      return {
        ...state,
        threadPages: nextThreadPages,
        threads: selectedLoading || overviewLoading ? { status: "loading" } : state.threads,
        paging: { ...state.paging, threads: false },
      };
    }
    case "threads/ready": {
      // Scope covers connection AND the query/status generation, so a page
      // fetched under a filter the owner has since changed is dropped instead
      // of merged into the newer result set.
      if (state.connectionId !== action.connectionId || state.threadScope !== action.scope) return state;
      // Only accept pages for projects the controller actually knows about, so
      // a stale or fabricated project cannot inject thread data.
      const projects = state.projects.status === "ready" ? state.projects.data.items : [];
      const knownProject = projects.length === 0 || projects.some((item) => item.connectionId === action.connectionId && item.projectId === action.projectId) || action.projectId === state.projectId;
      if (!knownProject) return state;
      const key = projectScopeKey(action.connectionId, action.projectId);
      const previousPage = state.threadPages[key]?.status === "ready" ? state.threadPages[key].data : null;
      const merged = mergeThreadPage(previousPage, action.page);
      // A background first-page refresh updates rows/total/freshness but must
      // not consume or regress the owner's continuation cursor. It only runs
      // for a fully loaded page, so preserving the previous cursor (null) is
      // the honest result; a new thread that would create another page is
      // discovered by an explicit load/reload, not by silently resetting this
      // cursor and making Load more repeat pages already on screen.
      const effective = action.source === "refresh" && previousPage
        ? { ...merged, nextCursor: previousPage.nextCursor }
        : merged;
      const nextThreadPages = { ...state.threadPages, [key]: { status: "ready", data: effective } as ReadState<Page<Thread>> };
      const observed = observeStatuses(state.observedThreadStatuses, effective.items);
      // Derive the displayed page from the inventory according to the view mode.
      let threads: ReadState<Page<Thread>>;
      if (state.threadView === "selected-project") {
        if (action.projectId === state.projectId) {
          threads = { status: "ready", data: effective };
        } else {
          threads = state.threads;
        }
      } else {
        threads = { status: "ready", data: aggregateThreadPages(nextThreadPages) };
      }
      return {
        ...state,
        threadPages: nextThreadPages,
        threads,
        observedThreadStatuses: observed,
        // A background summary refresh must not clear an explicit load-more
        // busy flag owned by another read.
        paging: action.source === "refresh" ? state.paging : { ...state.paging, threads: false },
      };
    }
    // A failure from a superseded scope is ignored too, so a late error can
    // never overwrite data that a newer, successful request already produced.
    case "threads/failed": {
      if (state.connectionId !== action.connectionId || state.threadScope !== action.scope) return state;
      const projects = state.projects.status === "ready" ? state.projects.data.items : [];
      const knownProject = projects.length === 0 || projects.some((item) => item.connectionId === action.connectionId && item.projectId === action.projectId) || action.projectId === state.projectId;
      if (!knownProject) return state;
      const key = projectScopeKey(action.connectionId, action.projectId);
      const nextThreadPages = { ...state.threadPages, [key]: { status: "error", error: action.error } as ReadState<Page<Thread>> };
      const selectedError = state.threadView === "selected-project" && action.projectId === state.projectId;
      // A partial overview keeps the rows it already has; only an overview with
      // no successful page becomes an error state, so the retry is actionable.
      const overview = state.threadView === "all-projects" ? aggregateThreadPages(nextThreadPages) : null;
      const overviewEmpty = overview !== null && overview.items.length === 0;
      return {
        ...state,
        threadPages: nextThreadPages,
        threads: selectedError || overviewEmpty
          ? { status: "error", error: action.error }
          : overview !== null
            ? { status: "ready", data: overview }
            : state.threads,
        paging: { ...state.paging, threads: false },
      };
    }

    case "detail/loading":
      return state.connectionId === action.connectionId && state.threadId === action.threadId
        ? {
          ...state,
          detail: { status: "loading" },
          detailPageError: null,
          activityReadInFlight: true,
          // A manual Refresh is a fresh attempt; do not keep the previous
          // terminal "stopped" notice on screen while it is loading.
          activityRefresh: { ...state.activityRefresh, terminal: false, error: null, consecutiveFailures: 0 },
          paging: { ...state.paging, activity: false },
        }
        : state;
    case "detail/ready": {
      if (state.connectionId !== action.connectionId || state.threadId !== action.threadId) return state;
      // The read is addressed by thread id alone, so verify the returned
      // identity before storing it. A response for a thread in another project
      // must never be attributed to the owner's current selection.
      const returned = action.detail.thread;
      if (returned.connectionId !== action.connectionId || returned.threadId !== action.threadId) return state;
      if (state.threadProjectId !== null && returned.projectId !== state.threadProjectId) return state;
      const observedAt = action.detail.freshness.observedAt;
      return {
        ...state,
        detail: { status: "ready", data: action.detail },
        detailPageError: null,
        activityReadInFlight: false,
        activityRefresh: activitySuccess(
          { connectionId: action.connectionId, projectId: returned.projectId, threadId: action.threadId },
          observedAt,
          observedAt ?? "",
        ),
        paging: { ...state.paging, activity: false },
      };
    }
    case "detail/page": {
      if (state.connectionId !== action.connectionId || state.threadId !== action.threadId || state.detail.status !== "ready") return state;
      const returned = action.detail.thread;
      if (returned.connectionId !== action.connectionId || returned.threadId !== action.threadId) return state;
      if (state.threadProjectId !== null && returned.projectId !== state.threadProjectId) return state;
      const observedAt = action.detail.freshness.observedAt;
      return {
        ...state,
        detail: { status: "ready", data: appendDetail(state.detail.data, action.detail) },
        detailPageError: null,
        activityReadInFlight: false,
        activityRefresh: activitySuccess(
          { connectionId: action.connectionId, projectId: returned.projectId, threadId: action.threadId },
          observedAt,
          observedAt ?? "",
        ),
        paging: { ...state.paging, activity: false },
      };
    }
    case "detail/refresh-start": {
      const identity = action;
      if (!detailIdentityMatches(state, identity)) return state;
      return {
        ...state,
        activityReadInFlight: true,
        activityRefresh: {
          ...state.activityRefresh,
          connectionId: identity.connectionId,
          projectId: identity.projectId,
          threadId: identity.threadId,
          lastAttemptAt: action.attemptedAt,
        },
      };
    }
    case "detail/refreshed": {
      const identity = action;
      if (!detailIdentityMatches(state, identity) || state.detail.status !== "ready") return state;
      const returned = action.detail.thread;
      if (returned.connectionId !== identity.connectionId ||
          returned.threadId !== identity.threadId ||
          returned.projectId !== identity.projectId) return state;
      const observedAt = action.detail.freshness.observedAt ?? action.attemptedAt;
      return {
        ...state,
        detail: { status: "ready", data: appendDetail(state.detail.data, action.detail) },
        detailPageError: null,
        activityReadInFlight: false,
        activityRefresh: activitySuccess(identity, observedAt, action.attemptedAt),
      };
    }
    case "detail/page-failed": {
      const identity = action;
      if (!detailIdentityMatches(state, identity) || state.detail.status !== "ready") return state;
      return { ...state, detailPageError: action.error, activityReadInFlight: false };
    }
    case "detail/refresh-failed": {
      const identity = action;
      if (!detailIdentityMatches(state, identity)) return state;
      return {
        ...state,
        activityReadInFlight: false,
        activityRefresh: activityFailure(state.activityRefresh, identity, action.error, action.attemptedAt),
      };
    }
    case "detail/continuation": {
      if (!detailIdentityMatches(state, action) || state.detail.status !== "ready") return state;
      return { ...state, detail: { status: "ready", data: replaceContinuation(state.detail.data, action.item) }, activityReadInFlight: false };
    }
    case "detail/failed": {
      if (state.connectionId !== action.connectionId || state.threadId !== action.threadId) return state;
      // The initial/manual read has its own error state. It must not claim a
      // live poll is retrying, because no poll loop is started without a ready
      // detail and an incremental cursor.
      return {
        ...state,
        detail: { status: "error", error: action.error },
        detailPageError: null,
        activityReadInFlight: false,
        paging: { ...state.paging, activity: false },
      };
    }

    case "activity/in-flight":
      return state.activityReadInFlight === action.active ? state : { ...state, activityReadInFlight: action.active };
    case "summary/refresh-start":
      return { ...state, summaryRefresh: { ...state.summaryRefresh, lastAttemptAt: action.attemptedAt } };
    case "summary/refresh-ok":
      return {
        ...state,
        summaryRefresh: {
          lastAttemptAt: state.summaryRefresh.lastAttemptAt,
          lastObservedAt: action.observedAt,
          error: null,
          consecutiveFailures: 0,
          terminal: false,
        },
      };
    case "summary/refresh-failed":
      return {
        ...state,
        summaryRefresh: {
          ...state.summaryRefresh,
          error: action.error,
          consecutiveFailures: state.summaryRefresh.consecutiveFailures + 1,
          // A terminal failure in any project in the batch stays terminal even
          // if a later project's failure was retryable.
          terminal: state.summaryRefresh.terminal || !action.error.retryable,
        },
      };

    case "busy":
      return { ...state, busy: action.phase, error: null, notice: null };
    case "idle":
      return { ...state, busy: null };
    case "paging":
      return state.paging[action.resource] === action.active ? state : { ...state, paging: { ...state.paging, [action.resource]: action.active } };
    case "notice":
      return { ...state, notice: action.message };
    case "error":
      return { ...state, error: action.error };
    case "private/clear":
      return { ...initialControllerState, inventory: unavailable, busy: null, threadPages: {} };
  }
}

/** Thrown-away pages are not silently truncated: `0` counts as a real cursor. */
export function hasMorePages(page: Page<unknown>): boolean {
  return page.nextCursor !== null;
}

/** Deterministic merge of every loaded per-project thread page. */
export function aggregateThreadPages(
  threadPages: Readonly<Record<string, ReadState<Page<Thread>>>>,
): Page<Thread> {
  const seen = new Set<string>();
  const items: Thread[] = [];
  let anyCursor = false;
  let total: number | null = 0;
  let totalKnown = true;
  let freshness: Freshness | null = null;
  for (const state of Object.values(threadPages)) {
    if (state.status !== "ready") continue;
    if (freshness === null) freshness = state.data.freshness;
    if (state.data.nextCursor !== null) anyCursor = true;
    if (state.data.total === null) totalKnown = false;
    else if (total !== null) total += state.data.total;
    for (const item of state.data.items) {
      const id = threadIdentity(item);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }
  items.sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return threadIdentity(left).localeCompare(threadIdentity(right));
  });
  return {
    items,
    nextCursor: anyCursor ? 0 : null,
    total: totalKnown ? total : null,
    freshness: freshness ?? { source: "backend", observedAt: null, stale: false },
  };
}

/**
 * Per-project coverage for the All-projects inventory.
 *
 * `total` is only meaningful for a project whose page was actually read. A
 * project that has not been read contributes no count at all, so the overview
 * can state that the global total is unknown instead of summing partial pages
 * and presenting that sum as the whole workspace.
 */
export interface ThreadCoverageProject {
  readonly connectionId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly page: "not-loaded" | "loading" | "ready" | "error";
  readonly loaded: number;
  readonly total: number | null;
  readonly nextCursor: number | null;
  readonly error: UiError | null;
}

export interface ThreadCoverage {
  readonly connectionId: string | null;
  /** Projects on the loaded project page(s), not an invented workspace total. */
  readonly projectsKnown: number;
  /** T3's project total when the project page reported one; otherwise null. */
  readonly projectsReportedTotal: number | null;
  readonly projectListPartial: boolean;
  readonly projectsRead: number;
  readonly projectsLoading: number;
  readonly projectsFailed: number;
  readonly projectsWithMoreThreads: number;
  /** Distinct loaded thread identities across the ready project pages. */
  readonly threadsLoaded: number;
  /** Sum of project totals only when every known project was read and no total is null. */
  readonly knownTotal: number | null;
  readonly totalUnknown: boolean;
  /** True whenever some project, page or total remains unobserved. */
  readonly partial: boolean;
  /** True when an explicit owner action can expand or repair coverage. */
  readonly canLoadMore: boolean;
  readonly canRetry: boolean;
  readonly perProject: readonly ThreadCoverageProject[];
}

export function summarizeThreadCoverage(input: {
  projects: ReadState<Page<Project>>;
  threadPages: Readonly<Record<string, ReadState<Page<Thread>>>>;
  connectionId: string | null;
}): ThreadCoverage {
  const connectionId = input.connectionId;
  const projectsState = input.projects;
  const projectsReady = projectsState.status === "ready";
  const projects = projectsState.status === "ready"
    ? projectsState.data.items.filter((project) => connectionId === null || project.connectionId === connectionId)
    : [];
  const projectListPartial = projectsState.status === "ready" && projectsState.data.nextCursor !== null;
  const perProject: ThreadCoverageProject[] = projects.map((project) => {
    const entry = input.threadPages[projectScopeKey(project.connectionId, project.projectId)];
    if (!entry || entry.status === "unavailable") {
      return {
        connectionId: project.connectionId,
        projectId: project.projectId,
        title: project.title,
        page: "not-loaded",
        loaded: 0,
        total: null,
        nextCursor: null,
        error: null,
      };
    }
    if (entry.status === "loading") {
      return {
        connectionId: project.connectionId,
        projectId: project.projectId,
        title: project.title,
        page: "loading",
        loaded: 0,
        total: null,
        nextCursor: null,
        error: null,
      };
    }
    if (entry.status === "error") {
      return {
        connectionId: project.connectionId,
        projectId: project.projectId,
        title: project.title,
        page: "error",
        loaded: 0,
        total: null,
        nextCursor: null,
        error: entry.error,
      };
    }
    return {
      connectionId: project.connectionId,
      projectId: project.projectId,
      title: project.title,
      page: "ready",
      loaded: entry.data.items.length,
      total: entry.data.total,
      nextCursor: entry.data.nextCursor,
      error: null,
    };
  });
  const ready = perProject.filter((project) => project.page === "ready");
  const identities = new Set<string>();
  for (const project of ready) {
    const entry = input.threadPages[projectScopeKey(project.connectionId, project.projectId)];
    if (!entry || entry.status !== "ready") continue;
    for (const thread of entry.data.items) identities.add(threadIdentity(thread));
  }
  const everyProjectRead = projects.length > 0 && ready.length === projects.length && !projectListPartial;
  const everyTotalKnown = everyProjectRead && ready.every((project) => project.total !== null);
  const knownTotal = everyTotalKnown
    ? ready.reduce((sum, project) => sum + (project.total ?? 0), 0)
    : projectsReady && projects.length === 0 && !projectListPartial
      ? 0
      : null;
  const projectsWithMoreThreads = ready.filter((project) => project.nextCursor !== null).length;
  const projectsFailed = perProject.filter((project) => project.page === "error").length;
  const projectsLoading = perProject.filter((project) => project.page === "loading").length;
  const partial = !projectsReady
    || projectListPartial
    || perProject.some((project) => project.page !== "ready" || project.nextCursor !== null);
  return {
    connectionId,
    projectsKnown: projects.length,
    projectsReportedTotal: projectsState.status === "ready" ? projectsState.data.total : null,
    projectListPartial,
    projectsRead: ready.length,
    projectsLoading,
    projectsFailed,
    projectsWithMoreThreads,
    threadsLoaded: identities.size,
    knownTotal,
    totalUnknown: knownTotal === null,
    partial,
    canLoadMore: projectsReady && (projectListPartial || perProject.some((project) => project.page !== "ready" || project.nextCursor !== null)),
    canRetry: projectsFailed > 0,
    perProject,
  };
}

/** Projects controller state onto the shape the dashboard view already renders. */
export function toDashboardData(state: ControllerState): DashboardData {
  if (state.inventory.status === "error") return { ...emptyDashboard(), environments: { status: "error", error: state.inventory.error } };
  if (state.inventory.status !== "ready") return { ...emptyDashboard(), environments: state.inventory };
  // The inventory route reports no upstream snapshot identity, so freshness is
  // Helm's own observation time rather than a T3-supplied one.
  const freshness: Freshness = { source: "backend", observedAt: state.inventoryObservedAt, stale: false };
  const items: ConnectedEnvironment[] = state.inventory.data.map((connection) => ({
    connection,
    // Only the selected connection has a verified identity read; the others
    // stay unknown instead of inheriting another server's identity.
    environment: state.connectionId === connection.connectionId && state.environment.status === "ready" ? state.environment.data : null,
  }));
  return {
    connection: deriveConnectionState(state),
    environments: { status: "ready", data: { items, nextCursor: null, total: items.length, freshness } },
    projects: state.projects,
    catalog: state.catalog,
    threads: state.threads,
    // Detail is addressed by the full identity, so the same thread ID in two
    // projects can never resolve to the other project's activity.
    details: state.connectionId && state.threadProjectId && state.threadId
      ? { [threadDetailKey(state.connectionId, state.threadProjectId, state.threadId)]: state.detail }
      : {},
    projectDetail: state.projectDetail,
  };
}

function emptyDashboard(): DashboardData {
  return { connection: { status: "not-connected" }, environments: unavailable, projects: unavailable, catalog: unavailable, threads: unavailable, details: {}, projectDetail: unavailable };
}