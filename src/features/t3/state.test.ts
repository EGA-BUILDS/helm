import { describe, expect, it } from "vitest";
import type { Catalog, ConnectionRecord, Freshness, Page, Project, Thread, ThreadDetail, UiError } from "./contract";
import { threadIdentity } from "./contract";
import {
  activeConnectionId,
  appendDetail,
  controllerReducer,
  deriveConnectionState,
  hasMorePages,
  initialControllerState,
  mergeActivity,
  mergePage,
  summarizeThreadCoverage,
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

function detail(threadId: string, positions: readonly number[], projectId = "proj_1"): ThreadDetail {
  return {
    thread: thread(threadId, { projectId }),
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
    { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1"), thread("thr_2")], null, 2) },
    { type: "select/thread", threadId: "thr_1", projectId: "proj_1" },
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

  it("keeps the last cursor when a forward read is caught up (nextPosition null)", () => {
    const previous = { ...detail("thr_1", [0, 1]), nextPosition: 1, hasMore: false };
    const caughtUp = { ...detail("thr_1", []), nextPosition: null, hasMore: false };
    const merged = appendDetail(previous, caughtUp);
    expect(merged.nextPosition).toBe(1);
    expect(merged.items.map((entry) => entry.position)).toEqual([0, 1]);
    expect(merged.hasMore).toBe(false);
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

  it("discards a detail response whose returned project does not match the selection", () => {
    const selected = apply(liveState(), { type: "select/thread", threadId: "thr_shared", projectId: "proj_2" });
    const mismatched = controllerReducer(selected, {
      type: "detail/ready", connectionId: "conn_1", threadId: "thr_shared",
      detail: detail("thr_shared", [0], "proj_1"),
    });
    expect(mismatched.detail).toEqual({ status: "unavailable" });
    const matching = controllerReducer(selected, {
      type: "detail/ready", connectionId: "conn_1", threadId: "thr_shared",
      detail: detail("thr_shared", [0], "proj_2"),
    });
    expect(matching.detail.status).toBe("ready");
  });

  it("discards activity when the thread changes but keeps the loaded threads", () => {
    const next = apply(liveState(), { type: "select/thread", threadId: "thr_2", projectId: "proj_1" });
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

describe("post-consent connection selection", () => {
  const both = [
    connection(),
    connection({ connectionId: "conn_ops", displayName: "Ops", access: "operate" }),
  ];

  it("selects the newly authorized operate connection after the inventory verifies it", () => {
    const before = apply(liveState(),
      { type: "thread/query", query: "nav" },
      { type: "thread/statuses", statuses: ["running"] });
    const next = apply(before, {
      type: "inventory/ready", connections: both, observedAt: "t", selectAccess: "operate",
    });
    expect(next.connectionId).toBe("conn_ops");
    // Every scoped read and filter belonging to the old connection is stale.
    expect(next.projects).toEqual({ status: "unavailable" });
    expect(next.threads).toEqual({ status: "unavailable" });
    expect(next.detail).toEqual({ status: "unavailable" });
    expect(next.projectId).toBeNull();
    expect(next.threadId).toBeNull();
    expect(next.threadQuery).toBe("");
    expect(next.threadStatuses).toEqual([]);
  });

  it("selects a newly authorized full-access connection only after the inventory confirms it", () => {
    const withFull = [
      ...both,
      connection({ connectionId: "conn_full", access: "full-access" }),
    ];
    const next = apply(liveState(), {
      type: "inventory/ready", connections: withFull, observedAt: "t", selectAccess: "full-access",
    });
    expect(next.connectionId).toBe("conn_full");
    const unverified = apply(liveState(), {
      type: "inventory/ready",
      connections: [connection(), connection({ connectionId: "conn_full", access: "full-access", status: "expired" })],
      observedAt: "t", selectAccess: "full-access",
    });
    expect(unverified.connectionId).toBe("conn_1");
  });

  it("never selects a tier the inventory did not verify as connected", () => {
    const missing = apply(liveState(), {
      type: "inventory/ready", connections: [connection()], observedAt: "t", selectAccess: "operate",
    });
    expect(missing.connectionId).toBe("conn_1");
    const expired = apply(liveState(), {
      type: "inventory/ready",
      connections: [connection(), connection({ connectionId: "conn_ops", access: "operate", status: "expired" })],
      observedAt: "t", selectAccess: "operate",
    });
    expect(expired.connectionId).toBe("conn_1");
  });

  it("keeps a read-only reconnect on the read-only row", () => {
    const next = apply(liveState(), {
      type: "inventory/ready", connections: both, observedAt: "t", selectAccess: "read-only",
    });
    expect(next.connectionId).toBe("conn_1");
  });

  it("does not override a manual selection on a later inventory refresh", () => {
    const selected = apply(liveState(),
      { type: "inventory/ready", connections: both, observedAt: "t", selectAccess: "operate" },
      { type: "select/connection", connectionId: "conn_1" });
    const refreshed = apply(selected, { type: "inventory/ready", connections: both, observedAt: "t2" });
    expect(refreshed.connectionId).toBe("conn_1");
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
    expect(controllerReducer(before, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_old", scope: 1, page: page([thread("ghost")], null) })).toBe(before);
    expect(controllerReducer(before, { type: "threads/failed", connectionId: "conn_1", projectId: "proj_old", scope: 1, error: { code: "unknown", message: "x", retryable: true } })).toBe(before);
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
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1")], null) },
      { type: "select/thread", threadId: "thr_1", projectId: "proj_1" });
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

  it("keys the selected thread detail by connection, project and thread", () => {
    const data = toDashboardData(liveState());
    // Thread IDs are only unique within a project, so the key must carry all three.
    expect(Object.keys(data.details)).toEqual([JSON.stringify(["conn_1", "proj_1", "thr_1"])]);
  });

  it("never attributes a detail to the wrong project when two projects reuse a thread id", () => {
    const base = apply(liveState(),
      // proj_2 loads a thread with the SAME upstream id as proj_1's thread.
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_2", scope: 1,
        page: page([thread("thr_1", { projectId: "proj_2", title: "proj_2 copy" })], null, 1) },
      { type: "select/thread", threadId: "thr_1", projectId: "proj_2" },
      { type: "detail/ready", connectionId: "conn_1", threadId: "thr_1", detail: detail("thr_1", [7], "proj_2") });
    const data = toDashboardData(base);
    // The detail slot names the project the owner actually selected.
    expect(Object.keys(data.details)).toEqual([JSON.stringify(["conn_1", "proj_2", "thr_1"])]);
    // And the two projects' identities are provably distinct, so they can never share a slot.
    expect(threadIdentity(thread("thr_1", { projectId: "proj_1" })))
      .not.toBe(threadIdentity(thread("thr_1", { projectId: "proj_2" })));
  });

  it("accumulates observed thread statuses so the filter cannot shrink to nothing", () => {
    const state = apply(liveState(),
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_3", { status: "waiting" })], null, 3) },
      { type: "thread/statuses", statuses: ["waiting"] },
      // The status filter bumped the scope, so this page carries the new token.
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 2, page: page([thread("thr_4", { status: "waiting" })], null, 1) });
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

/**
 * Regression coverage for the defects found during integration review. Each
 * test names the failure it prevents from coming back.
 */
describe("project scope changes reset server-side thread filters", () => {
  const filtered = () => apply(liveState(),
    { type: "thread/query", query: "deploy" },
    { type: "thread/statuses", statuses: ["running"] });

  it("does not carry the previous project's query into the next project", () => {
    expect(filtered().threadQuery).toBe("deploy");
    const next = controllerReducer(filtered(), { type: "select/project", projectId: "proj_2" });
    expect(next.projectId).toBe("proj_2");
    expect(next.threadQuery).toBe("");
  });

  it("does not carry the previous project's status filter into the next project", () => {
    expect(filtered().threadStatuses).toEqual(["running"]);
    expect(controllerReducer(filtered(), { type: "select/project", projectId: "proj_2" }).threadStatuses).toEqual([]);
  });

  it("clears the dependent thread selection and observed statuses", () => {
    const next = controllerReducer(filtered(), { type: "select/project", projectId: "proj_2" });
    expect(next.threadId).toBeNull();
    expect(next.observedThreadStatuses).toEqual([]);
    expect(next.threads).toEqual({ status: "unavailable" });
  });

  it("bumps the scope token so in-flight pages from the old project are rejected", () => {
    const before = filtered();
    const after = controllerReducer(before, { type: "select/project", projectId: "proj_2" });
    expect(after.threadScope).toBeGreaterThan(before.threadScope);
  });
});

describe("stale paginated thread responses", () => {
  it("drops a page fetched under a query the owner has since replaced", () => {
    const before = apply(liveState(), { type: "thread/query", query: "old" });
    const scopeWhenRequested = before.threadScope;
    const stale = page([thread("thr_stale", { title: "matched the old filter" })], null);
    // The owner keeps typing; the scope moves on while the request is in flight.
    const after = controllerReducer(before, { type: "thread/query", query: "new" });
    expect(controllerReducer(after, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: scopeWhenRequested, page: stale })).toBe(after);
  });

  it("drops a page fetched under a status filter the owner has since replaced", () => {
    const before = apply(liveState(), { type: "thread/statuses", statuses: ["waiting"] });
    const scopeWhenRequested = before.threadScope;
    const after = controllerReducer(before, { type: "thread/statuses", statuses: ["running"] });
    expect(controllerReducer(after, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: scopeWhenRequested, page: page([thread("thr_stale")], null) })).toBe(after);
  });

  it("does not let a late failure overwrite data a newer request already delivered", () => {
    const before = apply(liveState(), { type: "thread/query", query: "old" });
    const staleScope = before.threadScope;
    const fresh = controllerReducer(before, { type: "thread/query", query: "new" });
    const delivered = controllerReducer(fresh, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: fresh.threadScope, page: page([thread("thr_fresh")], null) });
    expect(delivered.threads.status).toBe("ready");
    const afterLateError = controllerReducer(delivered, { type: "threads/failed", connectionId: "conn_1", projectId: "proj_1", scope: staleScope, error: { code: "unknown", message: "stale failure", retryable: true } });
    expect(afterLateError.threads.status).toBe("ready");
  });

  it("still accepts a page that matches the live scope", () => {
    const state = liveState();
    const next = controllerReducer(state, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: state.threadScope, page: page([thread("thr_next")], null) });
    expect(next.threads.status === "ready" ? next.threads.data.items.map((item) => item.threadId) : []).toEqual(["thr_1", "thr_2", "thr_next"]);
  });

  it("keeps the pagination busy flag with the request that owns it", () => {
    const state = controllerReducer(liveState(), { type: "paging", resource: "threads", active: true });
    // Changing the filter ends the pagination that belonged to the old scope.
    const refiltered = controllerReducer(state, { type: "thread/query", query: "next" });
    expect(refiltered.paging.threads).toBe(false);
  });
});

describe("project detail read", () => {
  const detailProject = { ...project("proj_1"), workspaceRoot: "/srv/ega-house", defaultModel: "sonnet" };

  it("starts unavailable and moves through loading to ready", () => {
    expect(initialControllerState.projectDetail).toEqual({ status: "unavailable" });
    const loading = controllerReducer(liveState(), { type: "project/detail/loading", connectionId: "conn_1", projectId: "proj_1" });
    expect(loading.projectDetail).toEqual({ status: "loading" });
    const ready = controllerReducer(loading, { type: "project/detail/ready", connectionId: "conn_1", projectId: "proj_1", project: detailProject });
    expect(ready.projectDetail).toEqual({ status: "ready", data: detailProject });
  });

  it("surfaces a detail failure without disturbing the project list", () => {
    const error: UiError = { code: "unknown", message: "detail read failed", retryable: true };
    const next = controllerReducer(liveState(), { type: "project/detail/failed", connectionId: "conn_1", projectId: "proj_1", error });
    expect(next.projectDetail).toEqual({ status: "error", error });
    expect(next.projects.status).toBe("ready");
    expect(next.threads.status).toBe("ready");
  });

  it("discards a detail response for a project the owner already left", () => {
    const loading = controllerReducer(liveState(), { type: "project/detail/loading", connectionId: "conn_1", projectId: "proj_1" });
    const moved = controllerReducer(loading, { type: "select/project", projectId: "proj_2" });
    expect(controllerReducer(moved, { type: "project/detail/ready", connectionId: "conn_1", projectId: "proj_1", project: detailProject })).toBe(moved);
  });

  it("discards a detail response belonging to a different connection", () => {
    const before = liveState();
    expect(controllerReducer(before, { type: "project/detail/ready", connectionId: "conn_other", projectId: "proj_1", project: detailProject })).toBe(before);
  });

  it("projects the detail onto the dashboard data the view reads", () => {
    const state = controllerReducer(liveState(), { type: "project/detail/ready", connectionId: "conn_1", projectId: "proj_1", project: detailProject });
    expect(toDashboardData(state).projectDetail).toEqual({ status: "ready", data: detailProject });
  });

  it("resets the detail when the project selection changes", () => {
    const ready = controllerReducer(liveState(), { type: "project/detail/ready", connectionId: "conn_1", projectId: "proj_1", project: detailProject });
    expect(controllerReducer(ready, { type: "select/project", projectId: "proj_2" }).projectDetail).toEqual({ status: "unavailable" });
  });
});
describe("unified thread workspace", () => {
  it("keeps thread identities distinct across projects", () => {
    const left = thread("thr_same", { projectId: "proj_1" });
    const right = thread("thr_same", { projectId: "proj_2" });
    expect(threadIdentity(left)).not.toBe(threadIdentity(right));
  });

  it("never collides identical upstream ids across connections", () => {
    const left = thread("thr_same", { connectionId: "conn_1", projectId: "proj_1" });
    const right = thread("thr_same", { connectionId: "conn_2", projectId: "proj_1" });
    expect(threadIdentity(left)).not.toBe(threadIdentity(right));
  });

  it("merges same-named thread ids across projects without collision in all-projects mode", () => {
    const state = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_same", { projectId: "proj_1" })], null, 1) },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_2", scope: 1, page: page([thread("thr_same", { projectId: "proj_2" })], null, 1) },
    );
    expect(state.threadView).toBe("all-projects");
    expect(state.threads.status).toBe("ready");
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.items).toHaveLength(2);
  });

  it("drops a stale thread page for a superseded scope", () => {
    const before = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1", { projectId: "proj_1" })], null, 1) },
    );
    const after = controllerReducer(before, { type: "threads/ready", connectionId: "conn_1", projectId: "proj_2", scope: 0, page: page([thread("ghost", { projectId: "proj_2" })], null, 1) });
    expect(after).toBe(before);
    expect(after.threadPages[JSON.stringify(["conn_1", "proj_2"])]).toBeUndefined();
  });

  it("reports partial inventory when fewer projects are loaded", () => {
    const state = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1", { projectId: "proj_1" })], 2, 1) },
    );
    const readyProjects = Object.values(state.threadPages).filter((entry) => entry.status === "ready").length;
    expect(readyProjects).toBe(1);
    expect(readyProjects).toBeLessThan(2);
  });

  it("treats cursor zero as a real cursor in aggregate pages", () => {
    const state = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1")], null, 1) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1", { projectId: "proj_1" })], 0, 1) },
    );
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.nextCursor).toBe(0);
    expect(hasMorePages(state.threads.data)).toBe(true);
  });

  it("leaves selected-project mode unchanged by default", () => {
    const state = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "select/project", projectId: "proj_1" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1", { projectId: "proj_1" })], null, 1) },
    );
    expect(state.threadView).toBe("selected-project");
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.items.map((item) => item.threadId)).toEqual(["thr_1"]);
  });
});

describe("cross-project thread inventory coverage", () => {
  it("keeps the global total unknown when a known project has not been read", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1"), project("proj_2")], null, 2) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1", { projectId: "proj_1" })], null, 5) },
      },
    });
    expect(coverage.knownTotal).toBeNull();
    expect(coverage.totalUnknown).toBe(true);
    expect(coverage.partial).toBe(true);
    expect(coverage.canLoadMore).toBe(true);
    expect(coverage.projectsRead).toBe(1);
    expect(coverage.projectsKnown).toBe(2);
  });

  it("reports a total only when every known project page is read and every total is known", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1"), project("proj_2")], null, 2) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1", { projectId: "proj_1" })], null, 5) },
        [JSON.stringify(["conn_1", "proj_2"])]: { status: "ready", data: page([thread("thr_2", { projectId: "proj_2" }), thread("thr_3", { projectId: "proj_2" })], null, 3) },
      },
    });
    expect(coverage.knownTotal).toBe(8);
    expect(coverage.totalUnknown).toBe(false);
    expect(coverage.partial).toBe(false);
    expect(coverage.threadsLoaded).toBe(3);
  });

  it("does not turn a null upstream total into a known global total", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1")], null, 1) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1")], null, null) },
      },
    });
    expect(coverage.knownTotal).toBeNull();
    expect(coverage.totalUnknown).toBe(true);
  });

  it("treats a remaining project page as partial even when all listed projects are read", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1")], 2, 3) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1")], null, 1) },
      },
    });
    expect(coverage.projectListPartial).toBe(true);
    expect(coverage.partial).toBe(true);
    expect(coverage.knownTotal).toBeNull();
    expect(coverage.canLoadMore).toBe(true);
  });

  it("counts one identity once when an overlapping page repeats a thread", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1")], null, 1) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1"), thread("thr_1")], null, 1) },
      },
    });
    expect(coverage.threadsLoaded).toBe(1);
  });

  it("exposes a failed project as retryable without pretending its rows were read", () => {
    const coverage = summarizeThreadCoverage({
      projects: { status: "ready", data: page([project("proj_1"), project("proj_2")], null, 2) },
      connectionId: "conn_1",
      threadPages: {
        [JSON.stringify(["conn_1", "proj_1"])]: { status: "ready", data: page([thread("thr_1")], null, 1) },
        [JSON.stringify(["conn_1", "proj_2"])]: { status: "error", error: { code: "read_failed", message: "x", retryable: true } },
      },
    });
    expect(coverage.projectsFailed).toBe(1);
    expect(coverage.canRetry).toBe(true);
    expect(coverage.partial).toBe(true);
    expect(coverage.knownTotal).toBeNull();
  });
});

describe("overview filter and selection boundaries", () => {
  it("filters the overview locally without dropping loaded pages or changing scope", () => {
    const before = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1")], null, 1) },
    );
    const after = apply(before, { type: "thread/query", query: "nav" }, { type: "thread/statuses", statuses: ["running"] });
    expect(after.threadScope).toBe(before.threadScope);
    expect(after.threadPages[JSON.stringify(["conn_1", "proj_1"])]).toEqual(before.threadPages[JSON.stringify(["conn_1", "proj_1"])]);
    expect(after.threads.status).toBe("ready");
  });

  it("clears cached pages when a selected-project search changes, so old rows cannot merge back in", () => {
    const before = apply(liveState(), { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_cached")], null, 3) });
    const after = controllerReducer(before, { type: "thread/query", query: "new" });
    expect(after.threadPages).toEqual({});
  });

  it("clears cached pages when the view changes, so page totals from another filter scope are not reused", () => {
    const before = apply(liveState(), { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_cached")], null, 3) });
    const after = controllerReducer(before, { type: "thread/view", view: "all-projects" });
    expect(after.threadPages).toEqual({});
    expect(after.threads).toEqual({ status: "unavailable" });
  });

  it("keeps the overview pages and local filters when a project detail selection changes", () => {
    const before = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1")], null, 1) },
      { type: "thread/query", query: "nav" },
    );
    const after = controllerReducer(before, { type: "select/project", projectId: "proj_2" });
    expect(after.threadView).toBe("all-projects");
    expect(after.threadQuery).toBe("nav");
    expect(after.threadPages).toEqual(before.threadPages);
    expect(after.projectId).toBe("proj_2");
  });

  it("keeps a partial overview ready when one project fails, but surfaces an error when no page succeeded", () => {
    const error: UiError = { code: "read_failed", message: "one project failed", retryable: true };
    const partial = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1"), project("proj_2")], null, 2) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_1")], null, 1) },
      { type: "threads/failed", connectionId: "conn_1", projectId: "proj_2", scope: 1, error },
    );
    expect(partial.threads.status).toBe("ready");
    expect(partial.threadPages[JSON.stringify(["conn_1", "proj_2"])]).toEqual({ status: "error", error });

    const empty = apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1")], null, 1) },
      { type: "thread/view", view: "all-projects" },
      { type: "threads/failed", connectionId: "conn_1", projectId: "proj_1", scope: 1, error },
    );
    expect(empty.threads).toEqual({ status: "error", error });
  });
});

describe("thread page freshness policy", () => {
  function seeded(status: string, updatedAt: string | null) {
    return apply(
      initialControllerState,
      { type: "inventory/ready", connections: [connection()], observedAt: "t" },
      { type: "projects/ready", connectionId: "conn_1", page: page([project("proj_1")], null, 1) },
      { type: "select/project", projectId: "proj_1" },
      { type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1, page: page([thread("thr_same", { status, updatedAt })], null, 2) },
    );
  }
  function overlapped(state: ControllerState, status: string, updatedAt: string | null) {
    return controllerReducer(state, {
      type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1,
      page: page([thread("thr_same", { status, updatedAt })], null, 2),
    });
  }

  it("replaces a repeated identity when the later page carries newer evidence", () => {
    const state = overlapped(seeded("running", "2026-11-03T08:00:00.000Z"), "failed", "2026-11-03T09:00:00.000Z");
    expect(state.threads.status).toBe("ready");
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.items).toHaveLength(1);
    expect(state.threads.data.items[0]?.status).toBe("failed");
  });

  it("keeps the earlier evidence when the later page is older", () => {
    const state = overlapped(seeded("running", "2026-11-03T09:00:00.000Z"), "failed", "2026-11-03T08:00:00.000Z");
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.items[0]?.status).toBe("running");
  });

  it("uses the later page as the tie-break when timestamps are equal or unknown", () => {
    const equal = overlapped(seeded("running", "2026-11-03T09:00:00.000Z"), "failed", "2026-11-03T09:00:00.000Z");
    if (equal.threads.status !== "ready") throw new Error("expected ready");
    expect(equal.threads.data.items[0]?.status).toBe("failed");

    const unknown = overlapped(seeded("running", null), "completed", null);
    if (unknown.threads.status !== "ready") throw new Error("expected ready");
    expect(unknown.threads.data.items[0]?.status).toBe("completed");
  });

  it("does not let an unknown timestamp replace known evidence", () => {
    const state = overlapped(seeded("running", "2026-11-03T09:00:00.000Z"), "failed", null);
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.items[0]?.status).toBe("running");
  });

  it("preserves an unknown upstream total while merging rows", () => {
    const state = overlapped(seeded("running", "2026-11-03T09:00:00.000Z"), "failed", "2026-11-03T10:00:00.000Z");
    if (state.threads.status !== "ready") throw new Error("expected ready");
    expect(state.threads.data.total).toBe(2);
    const unknown = controllerReducer(state, {
      type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1,
      page: page([thread("thr_same", { status: "failed", updatedAt: "2026-11-03T11:00:00.000Z" })], null, null),
    });
    if (unknown.threads.status !== "ready") throw new Error("expected ready");
    expect(unknown.threads.data.total).toBeNull();
  });
});

describe("selected activity refresh state", () => {
  const started = (attemptedAt = "2026-10-12T09:10:00.000Z") => ({
    type: "detail/refresh-start" as const,
    connectionId: "conn_1",
    projectId: "proj_1",
    threadId: "thr_1",
    attemptedAt,
  });

  it("records the successful observation only after a read succeeds", () => {
    const before = liveState();
    expect(before.activityRefresh.lastObservedAt).toBe("2026-10-12T09:05:00.000Z");
    const pending = controllerReducer(before, started());
    expect(pending.activityRefresh.lastAttemptAt).toBe("2026-10-12T09:10:00.000Z");
    expect(pending.activityRefresh.lastObservedAt).toBe("2026-10-12T09:05:00.000Z");

    const refreshed = controllerReducer(pending, {
      type: "detail/refreshed",
      connectionId: "conn_1",
      projectId: "proj_1",
      threadId: "thr_1",
      attemptedAt: "2026-10-12T09:10:00.000Z",
      detail: { ...detail("thr_1", [0, 1, 2]), nextPosition: 3 },
    });
    if (refreshed.detail.status !== "ready") throw new Error("expected ready");
    expect(refreshed.detail.data.items.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(refreshed.activityRefresh.lastObservedAt).toBe(freshness.observedAt);
    expect(refreshed.activityRefresh.error).toBeNull();
    expect(refreshed.activityRefresh.consecutiveFailures).toBe(0);
  });

  it("keeps the last real observation and counts a failed attempt", () => {
    const error: UiError = { code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 5_000 };
    const failed = controllerReducer(liveState(), {
      type: "detail/refresh-failed",
      connectionId: "conn_1",
      projectId: "proj_1",
      threadId: "thr_1",
      error,
      attemptedAt: "2026-10-12T09:10:00.000Z",
    });
    expect(failed.activityRefresh.lastObservedAt).toBe("2026-10-12T09:05:00.000Z");
    expect(failed.activityRefresh.lastAttemptAt).toBe("2026-10-12T09:10:00.000Z");
    expect(failed.activityRefresh.error).toEqual(error);
    expect(failed.activityRefresh.consecutiveFailures).toBe(1);

    const second = controllerReducer(failed, {
      type: "detail/refresh-failed",
      connectionId: "conn_1",
      projectId: "proj_1",
      threadId: "thr_1",
      error,
      attemptedAt: "2026-10-12T09:11:00.000Z",
    });
    expect(second.activityRefresh.consecutiveFailures).toBe(2);
  });

  it("drops a refresh response for the same thread id in another project", () => {
    const before = liveState();
    const stale = controllerReducer(before, {
      type: "detail/refreshed",
      connectionId: "conn_1",
      projectId: "proj_2",
      threadId: "thr_1",
      attemptedAt: "2026-10-12T09:10:00.000Z",
      detail: { ...detail("thr_1", [9], "proj_2"), nextPosition: 10 },
    });
    expect(stale).toBe(before);
  });

  it("clears the refresh identity when the owner selects another thread", () => {
    const next = apply(liveState(), { type: "select/thread", threadId: "thr_2", projectId: "proj_1" });
    expect(next.activityRefresh).toEqual({
      connectionId: null, projectId: null, threadId: null,
      lastObservedAt: null, lastAttemptAt: null, error: null, consecutiveFailures: 0, terminal: false,
    });
  });

  it("tracks summary refresh separately from selected activity", () => {
    const attempted = controllerReducer(liveState(), { type: "summary/refresh-start", attemptedAt: "2026-10-12T09:10:00.000Z" });
    expect(attempted.summaryRefresh.lastAttemptAt).toBe("2026-10-12T09:10:00.000Z");
    const failed = controllerReducer(attempted, { type: "summary/refresh-failed", error: { code: "read_failed", message: "x", retryable: true } });
    expect(failed.summaryRefresh.consecutiveFailures).toBe(1);
    expect(failed.summaryRefresh.error?.code).toBe("read_failed");
    const ok = controllerReducer(failed, { type: "summary/refresh-ok", observedAt: "2026-10-12T09:11:00.000Z" });
    expect(ok.summaryRefresh).toEqual({
      lastAttemptAt: "2026-10-12T09:10:00.000Z",
      lastObservedAt: "2026-10-12T09:11:00.000Z",
      error: null,
      consecutiveFailures: 0,
      terminal: false,
    });
  });
});

describe("background summary refresh", () => {
  it("merges the refreshed first page without clearing an explicit load-more flag", () => {
    const before = apply(liveState(), { type: "paging", resource: "threads", active: true });
    const refreshed = controllerReducer(before, {
      type: "threads/ready",
      connectionId: "conn_1",
      projectId: "proj_1",
      scope: 1,
      source: "refresh",
      page: page([thread("thr_1", { status: "completed" }), thread("thr_new")], null, 3),
    });
    if (refreshed.threads.status !== "ready") throw new Error("expected ready");
    expect(refreshed.threads.data.items.map((item) => item.threadId)).toEqual(["thr_1", "thr_2", "thr_new"]);
    expect(refreshed.threads.data.items[0]?.status).toBe("completed");
    expect(refreshed.paging.threads).toBe(true);
  });
});

describe("EGA-815 review repairs", () => {
  it("does not claim a retrying poll when the initial detail read fails", () => {
    const error: UiError = { code: "read_failed", message: "initial read failed", retryable: true };
    const failed = controllerReducer(liveState(), {
      type: "detail/failed", connectionId: "conn_1", threadId: "thr_1", error,
    });
    expect(failed.detail).toEqual({ status: "error", error });
    // The initial read has its own error state; no live loop was started.
    expect(failed.activityRefresh.error).toBeNull();
    expect(failed.detailPageError).toBeNull();
  });

  it("keeps loaded activity and cursor when Load more fails", () => {
    const before = apply(liveState(), {
      type: "detail/ready", connectionId: "conn_1", threadId: "thr_1",
      detail: { ...detail("thr_1", [0, 1]), nextPosition: 2, hasMore: true },
    });
    const failed = controllerReducer(before, {
      type: "detail/page-failed", connectionId: "conn_1", projectId: "proj_1", threadId: "thr_1",
      error: { code: "read_failed", message: "load more failed", retryable: true },
    });
    if (failed.detail.status !== "ready") throw new Error("expected loaded detail");
    expect(failed.detail.data.items.map((item) => item.position)).toEqual([0, 1]);
    expect(failed.detail.data.nextPosition).toBe(2);
    expect(failed.detail.data.hasMore).toBe(true);
    expect(failed.detailPageError?.code).toBe("read_failed");
    expect(failed.activityRefresh.error).toBeNull();
  });

  it("preserves a fully consumed continuation cursor on a background first-page refresh", () => {
    const before = apply(liveState(), {
      type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1,
      page: page([thread("thr_1", { status: "running" }), thread("thr_2")], null, 2),
    });
    const refreshed = controllerReducer(before, {
      type: "threads/ready", connectionId: "conn_1", projectId: "proj_1", scope: 1,
      source: "refresh",
      page: page([thread("thr_1", { status: "completed" })], 7, 2),
    });
    const key = JSON.stringify(["conn_1", "proj_1"]);
    const entry = refreshed.threadPages[key];
    if (!entry || entry.status !== "ready") throw new Error("expected ready page");
    expect(entry.data.nextCursor).toBeNull();
    expect(entry.data.items.map((item) => item.threadId)).toEqual(["thr_1", "thr_2"]);
    expect(entry.data.items[0]?.status).toBe("completed");
  });

  it("drops a truncated continuation for the same thread id in another project", () => {
    const before = liveState();
    const stale = controllerReducer(before, {
      type: "detail/continuation", connectionId: "conn_1", projectId: "proj_2", threadId: "thr_1",
      item: { id: "thr_1-0", position: 0, kind: "assistant", text: "wrong project", createdAt: null, truncated: false, nextTextOffset: null },
    });
    expect(stale).toBe(before);
  });
});

describe("terminal poll failures", () => {
  it("marks a non-retryable failure terminal and clears it on success", () => {
    const terminal = controllerReducer(liveState(), {
      type: "detail/refresh-failed", connectionId: "conn_1", projectId: "proj_1", threadId: "thr_1",
      error: { code: "revoked", message: "Reconnect to continue.", retryable: false },
      attemptedAt: "2026-10-12T09:10:00.000Z",
    });
    expect(terminal.activityRefresh.terminal).toBe(true);
    expect(terminal.activityReadInFlight).toBe(false);

    const recovered = controllerReducer(terminal, {
      type: "detail/refreshed", connectionId: "conn_1", projectId: "proj_1", threadId: "thr_1",
      attemptedAt: "2026-10-12T09:11:00.000Z",
      detail: { ...detail("thr_1", [0, 1]), nextPosition: 2 },
    });
    expect(recovered.activityRefresh.terminal).toBe(false);
  });

  it("keeps a retryable failure non-terminal", () => {
    const failed = controllerReducer(liveState(), {
      type: "detail/refresh-failed", connectionId: "conn_1", projectId: "proj_1", threadId: "thr_1",
      error: { code: "read_failed", message: "temporary", retryable: true },
      attemptedAt: "2026-10-12T09:10:00.000Z",
    });
    expect(failed.activityRefresh.terminal).toBe(false);
  });
});

describe("EGA-815 residual repairs", () => {
  it("keeps a summary terminal failure sticky across a later retryable failure", () => {
    const first = controllerReducer(liveState(), {
      type: "summary/refresh-failed", error: { code: "revoked", message: "Reconnect.", retryable: false },
    });
    const second = controllerReducer(first, {
      type: "summary/refresh-failed", error: { code: "read_failed", message: "temporary", retryable: true },
    });
    expect(second.summaryRefresh.terminal).toBe(true);
  });

  it("clears a terminal activity notice when a manual refresh starts", () => {
    const terminal = controllerReducer(liveState(), {
      type: "detail/refresh-failed", connectionId: "conn_1", projectId: "proj_1", threadId: "thr_1",
      error: { code: "revoked", message: "Reconnect.", retryable: false },
      attemptedAt: "2026-10-12T09:10:00.000Z",
    });
    const loading = controllerReducer(terminal, { type: "detail/loading", connectionId: "conn_1", threadId: "thr_1" });
    expect(loading.activityRefresh.terminal).toBe(false);
    expect(loading.activityRefresh.error).toBeNull();
    expect(loading.activityReadInFlight).toBe(true);
  });
});
