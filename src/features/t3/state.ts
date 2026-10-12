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
  readonly detail: ReadState<ThreadDetail>;
  /** Single source of truth for the owner's current selection. */
  readonly connectionId: string | null;
  readonly projectId: string | null;
  readonly threadId: string | null;
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
  detail: unavailable,
  connectionId: null,
  projectId: null,
  threadId: null,
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
  detail: unavailable,
} as const;

export type ControllerAction =
  | { type: "inventory/start" }
  | { type: "inventory/ready"; connections: readonly ConnectionRecord[]; observedAt: string }
  | { type: "inventory/failed"; error: UiError }
  | { type: "oauth/pending"; expiresAt: string | null }
  | { type: "oauth/denied" }
  | { type: "oauth/expired" }
  | { type: "oauth/reset" }
  | { type: "select/connection"; connectionId: string | null }
  | { type: "select/project"; projectId: string | null }
  | { type: "select/thread"; threadId: string | null }
  | { type: "thread/query"; query: string }
  | { type: "thread/statuses"; statuses: readonly string[] }
  | { type: "environment/loading"; connectionId: string }
  | { type: "environment/ready"; connectionId: string; environment: Environment }
  | { type: "environment/failed"; connectionId: string; error: UiError }
  | { type: "catalog/loading"; connectionId: string }
  | { type: "catalog/ready"; connectionId: string; catalog: Catalog }
  | { type: "catalog/failed"; connectionId: string; error: UiError }
  | { type: "projects/loading"; connectionId: string }
  | { type: "projects/ready"; connectionId: string; page: Page<Project> }
  | { type: "projects/failed"; connectionId: string; error: UiError }
  | { type: "threads/loading"; connectionId: string; projectId: string }
  | { type: "threads/ready"; connectionId: string; projectId: string; page: Page<Thread> }
  | { type: "threads/failed"; connectionId: string; projectId: string; error: UiError }
  | { type: "detail/loading"; connectionId: string; threadId: string }
  | { type: "detail/ready"; connectionId: string; threadId: string; detail: ThreadDetail }
  | { type: "detail/page"; connectionId: string; threadId: string; detail: ThreadDetail }
  | { type: "detail/continuation"; connectionId: string; threadId: string; item: Activity }
  | { type: "detail/failed"; connectionId: string; threadId: string; error: UiError }
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
      const known = state.connectionId !== null && connections.some((entry) => entry.connectionId === state.connectionId);
      const connectionId = known
        ? state.connectionId
        : (connections.find((entry) => entry.status === "connected") ?? connections[0])?.connectionId ?? null;
      // A different selected connection means every scoped read is stale.
      return {
        ...state,
        inventory: { status: "ready", data: connections },
        inventoryObservedAt: action.observedAt,
        connectionId,
        ...(connectionId === state.connectionId ? {} : { ...dependentReads, projectId: null, threadId: null }),
        error: null,
      };
    }
    case "inventory/failed":
      return {
        ...state,
        inventory: { status: "error", error: action.error },
        inventoryObservedAt: null,
        ...dependentReads,
        projectId: null,
        threadId: null,
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
        threadId: null,
        threadQuery: "",
        threadStatuses: [],
        observedThreadStatuses: [],
        error: null,
      };
    case "select/project":
      if (action.projectId === state.projectId) return state;
      return {
        ...state,
        projectId: action.projectId,
        threads: unavailable,
        detail: unavailable,
        threadId: null,
        observedThreadStatuses: [],
      };
    case "select/thread":
      if (action.threadId === state.threadId) return state;
      return { ...state, threadId: action.threadId, detail: unavailable };
    case "thread/query":
      if (action.query === state.threadQuery) return state;
      return { ...state, threadQuery: action.query, threads: unavailable, detail: unavailable, threadId: null };
    case "thread/statuses":
      if (action.statuses.length === state.threadStatuses.length &&
          action.statuses.every((status, index) => status === state.threadStatuses[index])) return state;
      return { ...state, threadStatuses: action.statuses, threads: unavailable, detail: unavailable, threadId: null };

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
      return { ...state, projects: { status: "ready", data: mergePage(previous, action.page, (item) => `${item.connectionId}:${item.projectId}`) }, paging: { ...state.paging, projects: false } };
    }
    case "projects/failed":
      return scoped(state, action.connectionId) ? { ...state, projects: { status: "error", error: action.error }, paging: { ...state.paging, projects: false } } : state;

    case "threads/loading":
      return state.connectionId === action.connectionId && state.projectId === action.projectId
        ? { ...state, threads: { status: "loading" }, paging: { ...state.paging, threads: false } }
        : state;
    case "threads/ready": {
      if (state.connectionId !== action.connectionId || state.projectId !== action.projectId) return state;
      const previous = state.threads.status === "ready" ? state.threads.data : null;
      const merged = mergePage(previous, action.page, (item) => item.threadId);
      return {
        ...state,
        threads: { status: "ready", data: merged },
        observedThreadStatuses: observeStatuses(state.observedThreadStatuses, merged.items),
        paging: { ...state.paging, threads: false },
      };
    }
    case "threads/failed":
      return state.connectionId === action.connectionId && state.projectId === action.projectId
        ? { ...state, threads: { status: "error", error: action.error }, paging: { ...state.paging, threads: false } }
        : state;

    case "detail/loading":
      return state.connectionId === action.connectionId && state.threadId === action.threadId
        ? { ...state, detail: { status: "loading" }, paging: { ...state.paging, activity: false } }
        : state;
    case "detail/ready":
      return state.connectionId === action.connectionId && state.threadId === action.threadId
        ? { ...state, detail: { status: "ready", data: action.detail }, paging: { ...state.paging, activity: false } }
        : state;
    case "detail/page": {
      if (state.connectionId !== action.connectionId || state.threadId !== action.threadId || state.detail.status !== "ready") return state;
      return { ...state, detail: { status: "ready", data: appendDetail(state.detail.data, action.detail) }, paging: { ...state.paging, activity: false } };
    }
    case "detail/continuation": {
      if (state.connectionId !== action.connectionId || state.threadId !== action.threadId || state.detail.status !== "ready") return state;
      return { ...state, detail: { status: "ready", data: replaceContinuation(state.detail.data, action.item) } };
    }
    case "detail/failed":
      return state.connectionId === action.connectionId && state.threadId === action.threadId
        ? { ...state, detail: { status: "error", error: action.error }, paging: { ...state.paging, activity: false } }
        : state;

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
      return { ...initialControllerState, inventory: unavailable, busy: null };
  }
}

/** Thrown-away pages are not silently truncated: `0` counts as a real cursor. */
export function hasMorePages(page: Page<unknown>): boolean {
  return page.nextCursor !== null;
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
    details: state.connectionId && state.threadId ? { [threadDetailKey(state.connectionId, state.threadId)]: state.detail } : {},
  };
}

function emptyDashboard(): DashboardData {
  return { connection: { status: "not-connected" }, environments: unavailable, projects: unavailable, catalog: unavailable, threads: unavailable, details: {} };
}