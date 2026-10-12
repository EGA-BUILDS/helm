import { describe, expect, it } from "vitest";
import type { Catalog, ConnectionRecord, Freshness, Page, Project, Thread, ThreadDetail, UiError } from "./contract";
import {
  activeConnectionId,
  appendDetail,
  controllerReducer,
  deriveConnectionState,
  hasMorePages,
  initialControllerState,
  mergeActivity,
  mergePage,
  toDashboardData,
  type ControllerAction,
  type ControllerState,
} from "./state";

const freshness: Freshness = { source: "backend", observedAt: "2026-10-12T09:05:00.000Z", stale: false };

function apply(state: ControllerState, ...actions: readonly ControllerAction[]): ControllerState {
  return actions.reduce(controllerReducer, state);
}

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: "conn_1",
    displayName: "Studio",
    endpoint: "https://studio.t3coderelay.com/mcp",
    environmentId: "env_1",
    access: "read-only",
    status: "connected",
    lastVerifiedAt: "2026-10-12T09:00:00.000Z",
    lastReadAt: null,
    errorCode: null,
    expiresAt: "2026-11-11T09:00:00.000Z",
    ...overrides,
  };
}

function project(id: string): Project {
  return { connectionId: "conn_1", projectId: id, environmentId: "env_1", title: id, status: null };
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return { connectionId: "conn_1", threadId: id, projectId: "proj_1", environmentId: "env_1", title: id, status: "running", updatedAt: null, ...overrides };
}

function detail(threadId: string, positions: readonly number[]): ThreadDetail {
  return {
    thread: thread(threadId),
    items: positions.map((position) => ({ id: `${threadId}-${position}`, position, kind: "assistant", text: `t${position}`, createdAt: null, truncated: false, nextTextOffset: null })),
    recentRuns: [],
    nextPosition: null,
    hasMore: false,
    freshness,
  };
}

function page<T>(items: readonly T[], nextCursor: number | null, total: number | null = items.length): Page<T> {
  return { items, nextCursor, total, freshness };
}

/** A connected inventory with the scoped reads already loaded. */
function liveState(): ControllerState {
  return apply(
    initialControllerState,
    { type: "inventory/ready", connections: [connection()], observedAt: "2026-10-12T09:05:00.000Z" },
    { type: "environment/ready", connectionId: "conn_1", environment: { environmentId: "env_1", label: "Studio", serverVersion: "1.0.0", platform: "linux/x64" } },
    { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
    { type: "select/project", projectId: "proj_1" },
    { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", page: page([thread("thr_1"), thread("thr_2")], null, 2) },
    { type: "select/thread", threadId: "thr_1" },
    { type: "detail/ready", connectionId: "conn_1", threadId: "thr_1", detail: detail("thr_1", [0, 1]) },
  );
}

describe("page merging", () => {
  it("treats cursor zero as a real cursor", () => {
    expect(hasMorePages(page([], 0))).toBe(true);
    expect(hasMorePages(page([], null))).toBe(false);
  });

  it("replaces the first page and appends later ones", () => {
    const first = mergePage(null, page([project("a")], 3), (item) => item.projectId);
    const second = mergePage(first, page([project("b")], null, 2), (item) => item.projectId);
    expect(second.items.map((item) => item.projectId)).toEqual(["a", "b"]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(2);
  });

  it("drops duplicates an overlapping page boundary would introduce", () => {
    const first = mergePage(null, page([project("a"), project("b")], 2), (item) => item.projectId);
    const second = mergePage(first, page([project("b"), project("c")], null), (item) => item.projectId);
    expect(second.items.map((item) => item.projectId)).toEqual(["a", "b", "c"]);
  });

  it("keeps a later upstream total from a changing snapshot", () => {
    const first = mergePage(null, page([project("a")], 2, 9), (item) => item.projectId);
    const second = mergePage(first, page([project("b")], null, 10), (item) => item.projectId);
    expect(second.total).toBe(10);
  });

  it("never turns an upstream null total into zero", () => {
    expect(mergePage(null, page([project("a")], null, null), (item) => item.projectId).total).toBeNull();
  });
});

describe("activity merging", () => {
  const item = (id: string, position: number, text: string) => ({ id, position, kind: null, text, createdAt: null, truncated: false, nextTextOffset: null });

  it("orders an incremental page by position without dropping earlier items", () => {
    const merged = mergeActivity([item("a", 0, "one")], [item("b", 1, "two"), item("c", 2, "three")]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("replaces a repeated item so truncated text can be extended", () => {
    const merged = mergeActivity([item("a", 0, "part")], [item("a", 0, "part and more")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("part and more");
  });

  it("keeps recent runs and earlier activity when appending a page", () => {
    const previous = { ...detail("thr_1", [0]), recentRuns: [{ runId: "run_1", ordinal: null, status: null, providerInstanceId: null, model: null, requestedAt: null, startedAt: null, completedAt: null }] };
    const next = { ...detail("thr_1", [0, 1]), recentRuns: [{ runId: "run_2", ordinal: null, status: null, providerInstanceId: null, model: null, requestedAt: null, startedAt: null, completedAt: null }] };
    const merged = appendDetail(previous, next);
    expect(merged.items.map((entry) => entry.position)).toEqual([0, 1]);
    expect(merged.recentRuns.map((run) => run.runId)).toEqual(["run_1", "run_2"]);
  });
});

describe("selection invalidation", () => {
  it("discards every scoped read when the connection changes", () => {
    const next = apply(liveState(),
      { type: "inventory/ready", connections: [connection(), connection({ connectionId: "conn_2", displayName: "Laptop", environmentId: "env_2" })], observedAt: "t" },
      { type: "select/connection", connectionId: "conn_2" });
    expect(next.connectionId).toBe("conn_2");
    expect(next.projects).toEqual({ status: "unavailable" });
    expect(next.threads).toEqual({ status: "unavailable" });
    expect(next.detail).toEqual({ status: "unavailable" });
    expect(next.projectId).toBeNull();
    expect(next.threadId).toBeNull();
  });

  it("discards threads and activity when the project changes", () => {
    const next = apply(liveState(), { type: "select/project", projectId: "proj_2" });
    expect(next.threads).toEqual({ status: "unavailable" });
    expect(next.detail).toEqual({ status: "unavailable" });
    expect(next.threadId).toBeNull();
  });

  it("discards activity when the thread changes but keeps the loaded threads", () => {
    const next = apply(liveState(), { type: "select/thread", threadId: "thr_2" });
    expect(next.detail).toEqual({ status: "unavailable" });
    expect(next.threads.status).toBe("ready");
  });

  it("treats re-selecting the same value as a no-op", () => {
    const before = liveState();
    expect(apply(before, { type: "select/project", projectId: "proj_1" })).toBe(before);
  });

  it("discards scoped results when the owner changes the native filter", () => {
    const next = apply(liveState(), { type: "thread/query", query: "nav" });
    expect(next.threads).toEqual({ status: "unavailable" });
    expect(next.threadId).toBeNull();
  });

  it("ignores a status filter that did not actually change", () => {
    const withStatuses = apply(liveState(), { type: "thread/statuses", statuses: ["running"] });
    const before = withStatuses;
    expect(apply(withStatuses, { type: "thread/statuses", statuses: ["running"] })).toBe(before);
    expect(apply(withStatuses, { type: "thread/statuses", statuses: ["waiting"] }).threads).toEqual({ status: "unavailable" });
  });
});

describe("stale response handling", () => {
  it("drops a project page that belongs to a previous connection", () => {
    const before = liveState();
    const stale = controllerReducer(before, { type: "projects/ready", connectionId: "conn_old", page: page([project("ghost")], null) });
    expect(stale).toBe(before);
  });

  it("drops a thread page that belongs to a previous project", () => {
    const before = liveState();
    expect(controllerReducer(before, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_old", page: page([thread("ghost")], null) })).toBe(before);
    expect(controllerReducer(before, { type: "threads/failed", connectionId: "conn_1", projectId: "proj_old", error: { code: "unknown", message: "x", retryable: true } })).toBe(before);
  });

  it("drops activity that belongs to a previous thread", () => {
    const before = liveState();
    expect(controllerReducer(before, { type: "detail/ready", connectionId: "conn_1", threadId: "thr_old", detail: detail("thr_old", [0]) })).toBe(before);
    expect(controllerReducer(before, { type: "detail/page", connectionId: "conn_1", threadId: "thr_old", detail: detail("thr_old", [1]) })).toBe(before);
  });

  it("drops an appended activity page when no detail is loaded yet", () => {
    const bare = apply(initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "select/project", projectId: "proj_1" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", page: page([thread("thr_1")], null) },
      { type: "select/thread", threadId: "thr_1" });
    expect(controllerReducer(bare, { type: "detail/page", connectionId: "conn_1", threadId: "thr_1", detail: detail("thr_1", [0]) })).toBe(bare);
  });
});

describe("connection state derivation", () => {
  const error: UiError = { code: "unknown", message: "x", retryable: true };

  it("prefers a connected connection from the inventory", () => {
    const state = apply(initialControllerState, { type: "inventory/ready", connections: [connection({ status: "revoked" }), connection({ connectionId: "conn_2", status: "connected" })], observedAt: "t" });
    expect(state.connectionId).toBe("conn_2");
    expect(deriveConnectionState(state).status).toBe("connected");
    expect(activeConnectionId(state)).toBe("conn_2");
  });

  it.each(["revoked", "unreachable", "expired"] as const)("never presents a %s connection as connected", (status) => {
    const state = apply(initialControllerState, { type: "inventory/ready", connections: [connection({ status })], observedAt: "t" });
    expect(deriveConnectionState(state).status).toBe(status);
    expect(activeConnectionId(state)).toBeNull();
  });

  it("blocks scoped reads until a connection is verified", () => {
    const state = apply(initialControllerState, { type: "inventory/ready", connections: [connection({ status: "unreachable" })], observedAt: "t" });
    expect(activeConnectionId(state)).toBeNull();
  });

  it("reports no connection when the inventory is empty", () => {
    expect(deriveConnectionState(apply(initialControllerState, { type: "inventory/ready", connections: [], observedAt: "t" })).status).toBe("not-connected");
  });

  it("never invents a connected state from a pending consent flow", () => {
    const state = apply(initialControllerState, { type: "oauth/pending", expiresAt: "t" });
    expect(deriveConnectionState(state)).toEqual({ status: "pending", expiresAt: "t" });
    expect(activeConnectionId(state)).toBeNull();
  });

  it("keeps a saved connection visible after a failed refresh so it can be reconnected", () => {
    const state = apply(liveState(), { type: "inventory/ready", connections: [connection({ status: "unreachable", errorCode: "unreachable" })], observedAt: "t" });
    const derived = deriveConnectionState(state);
    expect(derived.status).toBe("unreachable");
    expect(derived).toHaveProperty("connection");
  });

  it("keeps the last inventory on screen while refreshing instead of flashing not-connected", () => {
    const before = liveState();
    expect(controllerReducer(before, { type: "inventory/start" })).toBe(before);
    expect(controllerReducer(initialControllerState, { type: "inventory/start" }).inventory).toEqual({ status: "loading" });
  });

  it("clears every private read when authorization is lost", () => {
    const cleared = apply(liveState(), { type: "private/clear" });
    expect(cleared.inventory).toEqual({ status: "unavailable" });
    expect(cleared.connectionId).toBeNull();
    expect(cleared.projectId).toBeNull();
    expect(cleared.threadId).toBeNull();
    expect(cleared.projects).toEqual({ status: "unavailable" });
    expect(cleared.detail).toEqual({ status: "unavailable" });
    expect(toDashboardData(cleared).connection.status).toBe("not-connected");
  });

  it("records an inventory failure as an error, never as empty data", () => {
    const state = controllerReducer(initialControllerState, { type: "inventory/failed", error });
    expect(state.inventory).toEqual({ status: "error", error });
    expect(toDashboardData(state).environments).toEqual({ status: "error", error });
  });
});

describe("dashboard projection", () => {
  it("attaches a verified identity only to the selected connection", () => {
    const state = apply(initialControllerState,
      { type: "inventory/ready", connections: [connection(), connection({ connectionId: "conn_2", environmentId: "env_2", displayName: "Laptop" })], observedAt: "t" },
      { type: "environment/ready", connectionId: "conn_1", environment: { environmentId: "env_1", label: "Studio", serverVersion: "1.0.0", platform: "linux/x64" } });
    const data = toDashboardData(state);
    expect(data.environments.status).toBe("ready");
    if (data.environments.status !== "ready") throw new Error("expected ready environments");
    expect(data.environments.data.items[0].environment?.serverVersion).toBe("1.0.0");
    expect(data.environments.data.items[1].environment).toBeNull();
    expect(data.environments.data.freshness).toEqual({ source: "backend", observedAt: "t", stale: false });
  });

  it("keys the selected thread detail by connection and thread", () => {
    const data = toDashboardData(liveState());
    expect(Object.keys(data.details)).toEqual([JSON.stringify(["conn_1", "thr_1"])]);
  });

  it("accumulates observed thread statuses so the filter cannot shrink to nothing", () => {
    const state = apply(liveState(),
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", page: page([thread("thr_3", { status: "waiting" })], null, 3) },
      { type: "thread/statuses", statuses: ["waiting"] },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", page: page([thread("thr_4", { status: "waiting" })], null, 1) });
    expect(state.observedThreadStatuses).toEqual(["running", "waiting"]);
  });
});

describe("catalog independence", () => {
  it("keeps a catalog failure separate from the project read", () => {
    const error: UiError = { code: "provider_unavailable", message: "T3 could not complete the read.", retryable: true };
    const state = controllerReducer(liveState(), { type: "catalog/failed", connectionId: "conn_1", error });
    expect(state.catalog).toEqual({ status: "error", error });
    expect(state.projects.status).toBe("ready");
  });

  it("accepts a catalog read for the selected connection only", () => {
    const catalog: Catalog = { providers: [], features: null, runtimeMode: null, interactionMode: null, freshness };
    expect(controllerReducer(liveState(), { type: "catalog/ready", connectionId: "conn_other", catalog }).catalog.status).toBe("unavailable");
    expect(controllerReducer(liveState(), { type: "catalog/ready", connectionId: "conn_1", catalog }).catalog.status).toBe("ready");
  });
});