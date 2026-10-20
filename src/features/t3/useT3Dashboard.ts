"use client";

/**
 * Live dashboard controller.
 *
 * This hook is deliberately thin: it owns request lifecycle (abort, staleness,
 * pagination) and delegates every state transition to the pure reducer in
 * `state.ts`. It is mounted once, behind the existing owner boundary in
 * `OwnerDashboard`, so nothing here changes who is allowed to read T3 data.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createT3Adapter, toUiError, isApprovedAuthorizationUrl } from "./backend";
import type { Activity, DashboardData, OAuthStartResult, T3Adapter, UiError } from "./contract";
import { activeConnectionId, controllerReducer, initialControllerState, toDashboardData, type ControllerState, type Resource } from "./state";

/** Coarse `t3` status values the backend callback route can redirect with. */
const callbackStatuses = ["connected", "denied", "expired", "failed"] as const;

export interface T3DashboardActions {
  selectConnection(connectionId: string | null): void;
  selectProject(projectId: string | null): void;
  selectThread(threadId: string | null, projectId: string | null): void;
  setThreadView(view: "selected-project" | "all-projects"): void;
  setThreadQuery(value: string): void;
  setThreadStatuses(statuses: readonly string[]): void;
  /** Resets the query and status filters together with any pending debounce. */
  clearThreadFilters(): void;
  connect(endpoint: string): Promise<void>;
  reconnect(connectionId: string): Promise<void>;
  refresh(connectionId: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  loadMoreProjects(): void;
  loadMoreThreads(): void;
  loadMoreActivity(): void;
  /**
   * Re-reads the currently selected thread's activity.
   *
   * Used after a native write was ACKNOWLEDGED, so the new activity appears
   * without the owner reselecting the thread. This is a read: it never repeats
   * the write, and it is not a completion signal.
   */
  reloadActivity(): void;
  loadTruncatedText(item: Activity): void;
  /** Applies the coarse status the backend callback route redirected with. */
  applyCallbackStatus(status: string): void;
}

export interface T3DashboardController {
  data: DashboardData;
  actions: T3DashboardActions;
  /** Single source of truth for the owner's current selection. */
  selection: { connectionId: string | null; projectId: string | null; threadId: string | null; threadProjectId: string | null };
  /** Native filter text, echoed back so the input stays controlled. */
  threadQueryInput: string;
  threadView: ControllerState["threadView"];
  threadProjectId: ControllerState["threadProjectId"];
  threadPages: ControllerState["threadPages"];
  threadStatuses: readonly string[];
  observedThreadStatuses: readonly string[];
  busy: ControllerState["busy"];
  paging: ControllerState["paging"];
  notice: string | null;
  error: UiError | null;
  /** True when the controller is driving the view with real backend reads. */
  live: true;
}

function messageFor(error: UiError): string {
  return error.retryable ? `${error.message} You can try again.` : error.message;
}

export function useT3Dashboard(options: { adapter?: T3Adapter; navigate?: (url: string) => void; enabled?: boolean } = {}): T3DashboardController {
  const [state, dispatch] = useReducer(controllerReducer, initialControllerState);
  // The adapter is created once; a caller may inject a fake for tests.
  const [adapter] = useState<T3Adapter>(() => options.adapter ?? createT3Adapter());
  // A fixture preview must never reach the network, so it disables every read.
  const enabled = options.enabled ?? true;
  const navigate = useMemo(() => options.navigate ?? ((url: string) => { window.location.assign(url); }), [options.navigate]);
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const [threadQueryInput, setThreadQueryInput] = useState("");
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One-shot requests that must be cancelled when the dashboard goes away. */
  const oneShot = useRef<AbortController[]>([]);
  const [inventoryVersion, setInventoryVersion] = useState(0);

  useEffect(() => () => {
    if (queryTimer.current) clearTimeout(queryTimer.current);
    for (const controller of oneShot.current) controller.abort();
    oneShot.current = [];
  }, []);

  /** Registers a one-shot request so unmount cancels it, then releases the slot. */
  const track = useCallback(() => {
    const controller = new AbortController();
    oneShot.current.push(controller);
    return controller;
  }, []);

  const release = useCallback((controller: AbortController) => {
    oneShot.current = oneShot.current.filter((entry) => entry !== controller);
  }, []);

  /** Access loss drops private reads rather than showing stale authorized data. */
  const failRead = useCallback((raw: unknown, report: (error: UiError) => void) => {
    const error = toUiError(raw);
    if (error.code === "access_denied") {
      dispatch({ type: "private/clear" });
      dispatch({ type: "error", error });
      return;
    }
    report(error);
  }, []);

  const connectionId = activeConnectionId(state);

  /** One consent flow shape for both a new connection and a reconnect. */
  const startConsent = useCallback(async (run: (signal: AbortSignal) => Promise<OAuthStartResult>) => {
    dispatch({ type: "busy", phase: "starting" });
    const controller = track();
    try {
      const started = await run(controller.signal);
      // Only an approved trusted T3 consent destination is ever navigated to.
      if (!isApprovedAuthorizationUrl(started.authorizationUrl)) {
        dispatch({ type: "error", error: { code: "invalid_endpoint", message: "Helm did not receive an approved T3 consent URL.", retryable: false } });
        return;
      }
      dispatch({ type: "oauth/pending", expiresAt: started.expiresAt });
      navigateRef.current(started.authorizationUrl);
    } catch (raw) {
      const error = toUiError(raw);
      dispatch({ type: "error", error: { ...error, message: messageFor(error) } });
    } finally {
      if (!controller.signal.aborted) dispatch({ type: "idle" });
    }
  }, [track]);

  // Connection inventory. Never starts an OAuth attempt on its own.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    dispatch({ type: "inventory/start" });
    adapter.listConnections(controller.signal)
      .then((connections) => {
        if (!controller.signal.aborted) dispatch({ type: "inventory/ready", connections, observedAt: new Date().toISOString() });
      })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "inventory/failed", error: ui })); });
    return () => controller.abort();
  }, [adapter, enabled, inventoryVersion, failRead]);

  // Environment identity, provider catalog and the first project page, in parallel.
  useEffect(() => {
    if (!enabled || !connectionId) return;
    const controller = new AbortController();
    const scoped = connectionId;
    dispatch({ type: "environment/loading", connectionId: scoped });
    dispatch({ type: "catalog/loading", connectionId: scoped });
    dispatch({ type: "projects/loading", connectionId: scoped });
    adapter.readEnvironment({ connectionId: scoped }, controller.signal)
      .then((environment) => { if (!controller.signal.aborted) dispatch({ type: "environment/ready", connectionId: scoped, environment }); })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "environment/failed", connectionId: scoped, error: ui })); });
    adapter.readCatalog({ connectionId: scoped }, controller.signal)
      .then((catalog) => { if (!controller.signal.aborted) dispatch({ type: "catalog/ready", connectionId: scoped, catalog }); })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "catalog/failed", connectionId: scoped, error: ui })); });
    adapter.listProjects({ connectionId: scoped }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) dispatch({ type: "projects/ready", connectionId: scoped, page }); })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "projects/failed", connectionId: scoped, error: ui })); });
    return () => controller.abort();
  }, [adapter, connectionId, enabled, failRead]);

  // Keep a valid project selected; threads are only ever read for one project.
  useEffect(() => {
    if (!connectionId || state.projects.status !== "ready") return;
    const known = new Set(state.projects.data.items.map((project) => project.projectId));
    if (state.projectId !== null && known.has(state.projectId)) return;
    dispatch({ type: "select/project", projectId: state.projects.data.items[0]?.projectId ?? null });
  }, [connectionId, state.projectId, state.projects]);

  // First thread page for the selected project. `t3_thread_list` is project-scoped.
  useEffect(() => {
    const projectId = state.projectId;
    if (!enabled || !connectionId || !projectId || state.threadView !== "selected-project") return;
    const controller = new AbortController();
    const scopedConnection = connectionId;
    const query = state.threadQuery;
    const statuses = state.threadStatuses;
    // The scope token is read once and carried by every dispatch from this
    // request, so a filter change mid-flight makes the response unmergeable.
    const scope = state.threadScope;
    dispatch({ type: "threads/loading", connectionId: scopedConnection, projectId, scope });
    adapter.listThreads({
      connectionId: scopedConnection, projectId,
      ...(query ? { titleContains: query } : {}),
      ...(statuses.length ? { statuses } : {}),
    }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) dispatch({ type: "threads/ready", connectionId: scopedConnection, projectId, scope, page }); })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "threads/failed", connectionId: scopedConnection, projectId, scope, error: ui })); });
    return () => controller.abort();
  }, [adapter, connectionId, enabled, state.projectId, state.threadQuery, state.threadStatuses, state.threadScope, state.threadView, failRead]);

  // In "all-projects" mode, read the first thread page of every project known
  // for the active connection. Fan-out is bounded and each request carries its
  // own AbortController so a scope change cancels stale reads.
  useEffect(() => {
    if (!enabled || !connectionId || state.threadView !== "all-projects") return;
    if (state.projects.status !== "ready") return;
    const projects = state.projects.data.items.filter((item) => item.connectionId === connectionId);
    if (projects.length === 0) return;
    const CAP = 6;
    const candidates = projects.slice(0, CAP);
    const scope = state.threadScope;
    const query = state.threadQuery;
    const statuses = state.threadStatuses;
    const controllers: AbortController[] = [];
    for (const project of candidates) {
      const key = JSON.stringify([connectionId, project.projectId]);
      const existing = state.threadPages[key];
      if (existing && (existing.status === "ready" || existing.status === "loading")) continue;
      const controller = new AbortController();
      controllers.push(controller);
      const scopedConnection = connectionId;
      const projectId = project.projectId;
      dispatch({ type: "threads/loading", connectionId: scopedConnection, projectId, scope });
      adapter.listThreads({
        connectionId: scopedConnection, projectId,
        ...(query ? { titleContains: query } : {}),
        ...(statuses.length ? { statuses } : {}),
      }, controller.signal)
        .then((page) => { if (!controller.signal.aborted) dispatch({ type: "threads/ready", connectionId: scopedConnection, projectId, scope, page }); })
        .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "threads/failed", connectionId: scopedConnection, projectId, scope, error: ui })); });
    }
    return () => { for (const controller of controllers) controller.abort(); };
  }, [adapter, connectionId, enabled, state.threadView, state.projects, state.threadScope, state.threadQuery, state.threadStatuses, state.threadPages, failRead]);

  /**
   * Project detail for the selected project only, via `t3_project_read`. This is
   * deliberately a separate request from `listProjects`: one detail read for the
   * one project the owner actually opened, so the list stays fast and a detail
   * failure cannot take the list down with it.
   */
  useEffect(() => {
    const projectId = state.projectId;
    if (!enabled || !connectionId || !projectId) return;
    const controller = new AbortController();
    const scopedConnection = connectionId;
    dispatch({ type: "project/detail/loading", connectionId: scopedConnection, projectId });
    adapter.readProject({ connectionId: scopedConnection, projectId }, controller.signal)
      .then((project) => { if (!controller.signal.aborted) dispatch({ type: "project/detail/ready", connectionId: scopedConnection, projectId, project }); })
      .catch((error) => {
        if (controller.signal.aborted) return;
        failRead(error, (ui) => dispatch({ type: "project/detail/failed", connectionId: scopedConnection, projectId, error: ui }));
      });
    return () => controller.abort();
  }, [adapter, connectionId, enabled, state.projectId, failRead]);

  // Bumped to force a fresh thread-activity read for the SAME selection.
  // Re-selecting an identical thread id would not re-run the effect, so an
  // acknowledged write could otherwise leave stale activity on screen.
  const [detailNonce, setDetailNonce] = useState(0);

  // Thread activity is only read after an explicit selection: `t3_thread_read`
  // is not guaranteed to be side-effect-free in every direct-parent context.
  useEffect(() => {
    const threadId = state.threadId;
    if (!enabled || !connectionId || !threadId) return;
    const controller = new AbortController();
    const scopedConnection = connectionId;
    dispatch({ type: "detail/loading", connectionId: scopedConnection, threadId });
    adapter.readThread({ connectionId: scopedConnection, threadId }, controller.signal)
      .then((detail) => { if (!controller.signal.aborted) dispatch({ type: "detail/ready", connectionId: scopedConnection, threadId, detail }); })
      .catch((error) => { if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "detail/failed", connectionId: scopedConnection, threadId, error: ui })); });
    return () => controller.abort();
  }, [adapter, connectionId, enabled, state.threadId, state.threadProjectId, failRead, detailNonce]);

  const loadMore = useCallback((resource: Resource, run: (signal: AbortSignal) => Promise<void>) => {
    if (state.paging[resource]) return;
    dispatch({ type: "paging", resource, active: true });
    const controller = track();
    run(controller.signal).finally(() => {
      release(controller);
      if (!controller.signal.aborted) dispatch({ type: "paging", resource, active: false });
    });
  }, [state.paging, track, release]);

  const actions = useMemo<T3DashboardActions>(() => ({
    selectConnection: (connectionId) => dispatch({ type: "select/connection", connectionId }),
    selectProject: (projectId) => dispatch({ type: "select/project", projectId }),
    selectThread: (threadId, projectId) => dispatch({ type: "select/thread", threadId, projectId }),
    reloadActivity: () => setDetailNonce((nonce) => nonce + 1),
    setThreadView: (view) => dispatch({ type: "thread/view", view }),
    setThreadStatuses: (statuses) => dispatch({ type: "thread/statuses", statuses }),
    setThreadQuery: (value) => {
      setThreadQueryInput(value);
      // Debounced so typing does not fan out one T3 read per keystroke.
      if (queryTimer.current) clearTimeout(queryTimer.current);
      queryTimer.current = setTimeout(() => dispatch({ type: "thread/query", query: value.trim() }), 300);
    },

    /**
     * The reducer clears the server-side query on a project change, but the
     * controlled input and any pending debounce live here in React state. They
     * are reset together so the visible field can never disagree with the query
     * the backend is actually being asked for.
     */
    clearThreadFilters() {
      if (queryTimer.current) {
        clearTimeout(queryTimer.current);
        queryTimer.current = null;
      }
      setThreadQueryInput("");
      dispatch({ type: "thread/query", query: "" });
      dispatch({ type: "thread/statuses", statuses: [] });
    },

    connect(endpoint) {
      return startConsent((signal) => adapter.startOAuth({ endpoint }, signal));
    },

    reconnect(connectionId) {
      // Reuses the existing connection id so no duplicate active grant is created.
      return startConsent((signal) => adapter.restartOAuth({ connectionId }, signal));
    },

    async refresh(connectionId) {
      dispatch({ type: "busy", phase: "refreshing" });
      const controller = track();
      try {
        const result = await adapter.refresh({ connectionId }, controller.signal);
        if (controller.signal.aborted) return;
        dispatch({ type: "environment/ready", connectionId, environment: result.environment });
        dispatch({ type: "notice", message: `T3 environment verified at ${result.observedAt}.` });
      } catch (raw) {
        if (controller.signal.aborted) return;
        const error = toUiError(raw);
        dispatch({ type: "error", error: { ...error, message: messageFor(error) } });
      } finally {
        release(controller);
        // Re-read the inventory so a refresh that downgraded the connection is visible.
        if (!controller.signal.aborted) {
          dispatch({ type: "idle" });
          setInventoryVersion((value) => value + 1);
        }
      }
    },

    async disconnect(connectionId) {
      dispatch({ type: "busy", phase: "disconnecting" });
      const controller = track();
      try {
        await adapter.disconnect({ connectionId }, controller.signal);
        if (controller.signal.aborted) return;
        dispatch({ type: "oauth/reset" });
        dispatch({ type: "notice", message: "T3 disconnected. Start a new sign-in to reconnect." });
      } catch (raw) {
        if (controller.signal.aborted) return;
        const error = toUiError(raw);
        dispatch({ type: "error", error: { ...error, message: messageFor(error) } });
      } finally {
        release(controller);
        if (!controller.signal.aborted) {
          dispatch({ type: "idle" });
          setInventoryVersion((value) => value + 1);
        }
      }
    },

    loadMoreProjects() {
      if (!connectionId) return;
      const page = state.projects.status === "ready" ? state.projects.data : null;
      const cursor = page?.nextCursor ?? null;
      if (cursor === null) return;
      loadMore("projects", async (signal) => {
        try {
          const next = await adapter.listProjects({ connectionId, cursor }, signal);
          dispatch({ type: "projects/ready", connectionId, page: next });
        } catch (raw) {
          failRead(raw, (error) => dispatch({ type: "projects/failed", connectionId, error }));
        }
      });
    },

    loadMoreThreads() {
      if (!connectionId) return;
      const scopedConnection = connectionId;
      const query = state.threadQuery;
      const statuses = state.threadStatuses;
      const scope = state.threadScope;
      if (state.threadView === "all-projects") {
        const knownProjects = state.projects.status === "ready" ? state.projects.data.items.filter((item) => item.connectionId === connectionId) : [];
        const loadedKeys = new Set(Object.keys(state.threadPages));
        // First, expand project coverage: read the first page of projects that
        // have not been read yet, before paginating any already-loaded project.
        const unloaded = knownProjects.filter((project) => !loadedKeys.has(JSON.stringify([connectionId, project.projectId])));
        const CAP = 6;
        const batch = (unloaded.length > 0 ? unloaded : knownProjects.filter((project) => {
          const entry = state.threadPages[JSON.stringify([connectionId, project.projectId])];
          return entry?.status === "ready" && entry.data.nextCursor !== null;
        })).slice(0, CAP);
        if (batch.length === 0) return;
        // Unloaded projects: first page. Already-loaded projects with a cursor:
        // next page. These are mutually exclusive per batch above.
        const toFetch = batch.map((project) => {
          const key = JSON.stringify([connectionId, project.projectId]);
          const entry = state.threadPages[key];
          const cursor = entry?.status === "ready" ? entry.data.nextCursor : null;
          return { projectId: project.projectId, cursor };
        });
        loadMore("threads", async (signal) => {
          for (const { projectId, cursor } of toFetch) {
            try {
              const next = await adapter.listThreads({
                connectionId: scopedConnection, projectId,
                ...(cursor !== null ? { cursor } : {}),
                ...(query ? { titleContains: query } : {}),
                ...(statuses.length ? { statuses } : {}),
              }, signal);
              dispatch({ type: "threads/ready", connectionId: scopedConnection, projectId, scope, page: next });
            } catch (raw) {
              failRead(raw, (error) => dispatch({ type: "threads/failed", connectionId: scopedConnection, projectId, scope, error }));
            }
          }
        });
        return;
      }
      const projectId = state.projectId;
      if (!projectId) return;
      const page = state.threads.status === "ready" ? state.threads.data : null;
      const cursor = page?.nextCursor ?? null;
      if (cursor === null) return;
      loadMore("threads", async (signal) => {
        try {
          const next = await adapter.listThreads({
            connectionId: scopedConnection, projectId, cursor,
            ...(query ? { titleContains: query } : {}),
            ...(statuses.length ? { statuses } : {}),
          }, signal);
          dispatch({ type: "threads/ready", connectionId: scopedConnection, projectId, scope, page: next });
        } catch (raw) {
          failRead(raw, (error) => dispatch({ type: "threads/failed", connectionId: scopedConnection, projectId, scope, error }));
        }
      });
    },

    loadMoreActivity() {
      const threadId = state.threadId;
      if (!connectionId || !threadId) return;
      const detail = state.detail.status === "ready" ? state.detail.data : null;
      const afterPosition = detail?.nextPosition ?? null;
      if (!detail?.hasMore || afterPosition === null) return;
      const scopedConnection = connectionId;
      loadMore("activity", async (signal) => {
        try {
          const next = await adapter.readThread({ connectionId: scopedConnection, threadId, afterPosition }, signal);
          dispatch({ type: "detail/page", connectionId: scopedConnection, threadId, detail: next });
        } catch (raw) {
          failRead(raw, (error) => dispatch({ type: "detail/failed", connectionId: scopedConnection, threadId, error }));
        }
      });
    },

    loadTruncatedText(item) {
      const threadId = state.threadId;
      if (!connectionId || !threadId) return;
      const offset = item.nextTextOffset ?? null;
      if (offset === null) {
        dispatch({ type: "error", error: { code: "not_found", message: "T3 did not return a further text offset for that item.", retryable: false } });
        return;
      }
      const scopedConnection = connectionId;
      const controller = track();
      adapter.loadTruncatedText({ connectionId: scopedConnection, threadId, itemId: item.id, textOffset: offset }, controller.signal)
        .then((continuation) => { if (!controller.signal.aborted) dispatch({ type: "detail/continuation", connectionId: scopedConnection, threadId, item: continuation }); })
        .catch((raw) => {
          if (controller.signal.aborted) return;
          const error = toUiError(raw);
          dispatch({ type: "error", error: { ...error, message: messageFor(error) } });
        })
        .finally(() => release(controller));
    },

    applyCallbackStatus(status) {
      if (!callbackStatuses.includes(status as (typeof callbackStatuses)[number])) return;
      if (status === "connected") {
        dispatch({ type: "oauth/reset" });
        dispatch({ type: "notice", message: "T3 connected. Verifying the environment…" });
        setInventoryVersion((value) => value + 1);
        return;
      }
      if (status === "denied") dispatch({ type: "oauth/denied" });
      else if (status === "expired") dispatch({ type: "oauth/expired" });
      else dispatch({ type: "error", error: { code: "unknown", message: "The T3 connection could not be completed. No access was granted.", retryable: true } });
      setInventoryVersion((value) => value + 1);
    },
  }), [adapter, connectionId, failRead, loadMore, release, startConsent, state, track]);

  const data = useMemo(() => toDashboardData(state), [state]);

  return {
    data,
    actions,
    selection: { connectionId: state.connectionId, projectId: state.projectId, threadId: state.threadId, threadProjectId: state.threadProjectId },
    threadQueryInput,
    threadView: state.threadView,
    threadProjectId: state.threadProjectId,
    threadPages: state.threadPages,
    threadStatuses: state.threadStatuses,
    observedThreadStatuses: state.observedThreadStatuses,
    busy: state.busy,
    paging: state.paging,
    notice: state.notice,
    error: state.error,
    live: true,
  };
}