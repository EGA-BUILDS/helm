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
import { projectScopeKey, type AccessLevel, type Activity, type DashboardData, type OAuthStartResult, type T3Adapter, type UiError } from "./contract";
import {
  activeConnectionId,
  controllerReducer,
  initialControllerState,
  toDashboardData,
  type ActivityRefreshState,
  type ControllerState,
  type Resource,
  type SummaryRefreshState,
} from "./state";
import { scopeFailureMessage } from "./ui";
import {
  ACTIVITY_POLL_INTERVAL_MS,
  SUMMARY_POLL_INTERVAL_MS,
  activityPollDelay,
  activityPollPauseReason,
  summaryPollDelay,
  type ActivityPollPauseReason,
} from "./polling";

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
  connect(endpoint: string, access?: AccessLevel): Promise<void>;
  reconnect(connectionId: string, access?: AccessLevel): Promise<void>;
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
  /**
   * Applies the coarse status the backend callback route redirected with.
   * `reason` is a fixed display hint; `access` is a bounded selection hint.
   * Neither is proof of authorization.
   */
  applyCallbackStatus(status: string, outcome?: { reason?: string | null; access?: string | null }): void;
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
  /** A failed explicit Load more; already-loaded items are preserved. */
  detailPageError: UiError | null;
  /** True while any selected-thread activity read owns the single slot. */
  activityReadInFlight: boolean;
  /** Last successful selected-thread read and its honest failure state. */
  activityRefresh: ActivityRefreshState;
  /** Slower cross-project summary refresh state. */
  summaryRefresh: SummaryRefreshState;
  /** Null while the selected thread is polling; otherwise the honest pause reason. */
  activityPauseReason: ActivityPollPauseReason | null;
  /** True when the controller is driving the view with real backend reads. */
  live: true;
}

function messageFor(error: UiError): string {
  return error.retryable ? `${error.message} You can try again.` : error.message;
}

/**
 * Tracks real tab visibility. A hidden tab must not keep a timer or a request
 * alive; the polling effects tear down and restart on the visibility event.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
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
  /**
   * All-projects reads are tracked by project identity, not by effect cleanup.
   * The fan-out changes controller state as each page arrives; aborting on
   * every such render would cancel sibling project reads mid-flight.
   */
  const overviewRequests = useRef(new Map<string, AbortController>());
  /** Explicit load-more batches, tracked by resource so a view/scope change aborts them. */
  const pagingRequests = useRef(new Map<Resource, AbortController>());
  /** Latest pages for the fan-out effect without making it re-run on each page. */
  const threadPagesRef = useRef(state.threadPages);
  useEffect(() => { threadPagesRef.current = state.threadPages; }, [state.threadPages]);
  /** Current lifecycle values for the serial batch loop, which is not an effect. */
  const lifecycleRef = useRef({ connectionId: null as string | null, view: state.threadView, scope: state.threadScope });
  useEffect(() => {
    lifecycleRef.current = { connectionId: activeConnectionId(state), view: state.threadView, scope: state.threadScope };
  }, [state]);
  const [inventoryVersion, setInventoryVersion] = useState(0);
  /**
   * One-shot selection hint from a successful callback. It is consumed by the
   * next authenticated inventory read and never reused, so a later manual
   * selection cannot be overridden by a stale consent outcome.
   */
  const pendingSelection = useRef<AccessLevel | null>(null);

  const documentVisible = useDocumentVisible();
  /** Latest controller state for timer callbacks that must not re-run an effect. */
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  /**
   * One selected-thread activity request at a time. Every read that consumes
   * the activity cursor (initial detail, poll, Load more, truncated text) owns
   * the same controller slot, so replacing or abandoning it aborts the old
   * request synchronously. The token still prevents an old finally from
   * clearing the busy flag owned by a newer request.
   */
  const activityToken = useRef(0);
  const activityRequest = useRef<{
    token: number;
    connectionId: string;
    projectId: string;
    threadId: string;
    controller: AbortController;
  } | null>(null);
  const beginActivityRequest = useCallback((
    connectionId: string,
    projectId: string,
    threadId: string,
    controller = new AbortController(),
  ) => {
    // A newer read owns the single activity slot. Abort the previous request
    // before it can overlap; its own token can no longer affect the new slot.
    activityRequest.current?.controller.abort();
    const token = activityToken.current + 1;
    activityToken.current = token;
    activityRequest.current = { token, connectionId, projectId, threadId, controller };
    return { token, controller };
  }, []);
  const endActivityRequest = useCallback((token: number) => {
    const owned = activityRequest.current?.token === token;
    if (owned) activityRequest.current = null;
    return owned;
  }, []);
  /** A stale success or error may only be applied while its token still owns the slot. */
  const ownsActivityRequest = useCallback((token: number) => activityRequest.current?.token === token, []);
  /** The live poll loop, if one is running, so a manual action can stop it synchronously. */
  const activityPoll = useRef<{ stop: () => void } | null>(null);
  const stopActivityPoll = useCallback(() => {
    activityPoll.current?.stop();
    activityPoll.current = null;
  }, []);
  /**
   * Synchronously cancel every selected-thread activity read and release the
   * busy slots. A selection change or manual Refresh must not wait for React
   * effect cleanup: a late continuation could otherwise land on the newer
   * identity, and a stale `failRead` could clear newer private state.
   */
  const cancelActivityReads = useCallback(() => {
    stopActivityPoll();
    const current = activityRequest.current;
    activityRequest.current = null;
    current?.controller.abort();
    const paging = pagingRequests.current.get("activity");
    if (paging && paging !== current?.controller) paging.abort();
    if (paging) pagingRequests.current.delete("activity");
    if (current || paging) {
      dispatch({ type: "activity/in-flight", active: false });
      dispatch({ type: "paging", resource: "activity", active: false });
    }
  }, [stopActivityPoll]);

  useEffect(() => () => {
    stopActivityPoll();
    const activity = activityRequest.current;
    activityRequest.current = null;
    activity?.controller.abort();
    if (queryTimer.current) clearTimeout(queryTimer.current);
    for (const controller of oneShot.current) controller.abort();
    oneShot.current = [];
    for (const controller of overviewRequests.current.values()) controller.abort();
    overviewRequests.current.clear();
    for (const controller of pagingRequests.current.values()) controller.abort();
    pagingRequests.current.clear();
  }, [stopActivityPoll]);

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

  // One lifecycle generation covers connection, view and thread scope. Old
  // overview reads and serial load-more batches must stop before the new
  // generation starts; a normal page update is deliberately not in this list,
  // so a successful sibling never cancels the remaining reads.
  useEffect(() => {
    for (const controller of overviewRequests.current.values()) controller.abort();
    overviewRequests.current.clear();
    for (const [resource, controller] of pagingRequests.current) {
      controller.abort();
      dispatch({ type: "paging", resource, active: false });
    }
    pagingRequests.current.clear();
  }, [connectionId, state.threadView, state.threadScope]);

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
        if (controller.signal.aborted) return;
        const selectAccess = pendingSelection.current;
        pendingSelection.current = null;
        dispatch({
          type: "inventory/ready", connections, observedAt: new Date().toISOString(),
          ...(selectAccess ? { selectAccess } : {}),
        });
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
  // for the active connection. Fan-out is bounded. Search and work-state
  // filters are applied to the loaded rows locally, so they cannot hide a row
  // whose title does not contain the search text or turn a partial page count
  // into a filtered "total". A failed project is retried only by an explicit
  // owner action, never by an effect that would loop on the same failure.
  useEffect(() => {
    if (!enabled || !connectionId || state.threadView !== "all-projects") return;
    if (state.projects.status !== "ready") return;
    const projects = state.projects.data.items.filter((item) => item.connectionId === connectionId);
    if (projects.length === 0) return;
    const CAP = 6;
    const scope = state.threadScope;
    for (const project of projects.slice(0, CAP)) {
      const key = JSON.stringify([connectionId, project.projectId]);
      const existing = threadPagesRef.current[key];
      if (existing && existing.status !== "unavailable") continue;
      if (overviewRequests.current.has(key)) continue;
      const controller = new AbortController();
      overviewRequests.current.set(key, controller);
      const projectId = project.projectId;
      dispatch({ type: "threads/loading", connectionId, projectId, scope });
      adapter.listThreads({ connectionId, projectId }, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) dispatch({ type: "threads/ready", connectionId, projectId, scope, page });
        })
        .catch((error) => {
          if (!controller.signal.aborted) failRead(error, (ui) => dispatch({ type: "threads/failed", connectionId, projectId, scope, error: ui }));
        })
        .finally(() => {
          if (overviewRequests.current.get(key) === controller) overviewRequests.current.delete(key);
        });
    }
  }, [adapter, connectionId, enabled, state.threadView, state.projects, state.threadScope, failRead]);

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
    const scopedConnection = connectionId;
    const scopedProjectId = state.threadProjectId;
    const projectId = scopedProjectId ?? "";
    const { token, controller } = beginActivityRequest(scopedConnection, projectId, threadId);
    const attemptedAt = new Date().toISOString();
    // A manual Refresh (nonce bump) of an already-loaded selection continues
    // from its cursor. A full re-read starts at the OLDEST activity item, so
    // replacing the loaded pages with that first page would hide the newest
    // activity and re-open a continuation the loop must walk again.
    const live = stateRef.current;
    const loaded = live.detail.status === "ready" ? live.detail.data : null;
    const incrementalRefresh = detailNonce > 0 && loaded !== null && scopedProjectId !== null &&
      loaded.thread.connectionId === scopedConnection &&
      loaded.thread.threadId === threadId &&
      loaded.thread.projectId === scopedProjectId &&
      loaded.nextPosition !== null
      ? { projectId: scopedProjectId, afterPosition: loaded.nextPosition }
      : null;
    if (incrementalRefresh !== null) {
      dispatch({
        type: "detail/refresh-start",
        connectionId: scopedConnection,
        projectId: incrementalRefresh.projectId,
        threadId,
        attemptedAt,
      });
    } else {
      dispatch({ type: "detail/loading", connectionId: scopedConnection, threadId });
    }
    const read = incrementalRefresh !== null
      ? adapter.readThread({
        connectionId: scopedConnection,
        threadId,
        afterPosition: incrementalRefresh.afterPosition,
      }, controller.signal)
      : adapter.readThread({ connectionId: scopedConnection, threadId }, controller.signal);
    read
      .then((detail) => {
        if (controller.signal.aborted || !ownsActivityRequest(token)) return;
        if (incrementalRefresh !== null) {
          dispatch({
            type: "detail/refreshed",
            connectionId: scopedConnection,
            projectId: incrementalRefresh.projectId,
            threadId,
            detail,
            attemptedAt,
          });
        } else {
          dispatch({ type: "detail/ready", connectionId: scopedConnection, threadId, detail });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || !ownsActivityRequest(token)) return;
        if (incrementalRefresh !== null) {
          failRead(error, (ui) => dispatch({
            type: "detail/refresh-failed",
            connectionId: scopedConnection,
            projectId: incrementalRefresh.projectId,
            threadId,
            error: ui,
            attemptedAt,
          }));
        } else {
          failRead(error, (ui) => dispatch({ type: "detail/failed", connectionId: scopedConnection, threadId, error: ui, attemptedAt }));
        }
      })
      .finally(() => endActivityRequest(token));
    return () => {
      controller.abort();
      endActivityRequest(token);
    };
  }, [adapter, connectionId, enabled, state.threadId, state.threadProjectId, failRead, detailNonce, beginActivityRequest, endActivityRequest, ownsActivityRequest]);

  /**
   * Selected-thread activity polling. One loop, one request, one selection.
   * The effect is keyed by the complete identity plus the eligibility boolean,
   * so a project/thread/connection switch or a hidden tab tears it down before
   * a new loop can start. Timer callbacks re-check live state because React
   * cleanup runs after the render that invalidated the selection.
   */
  const selectedDetail = state.detail.status === "ready" ? state.detail.data : null;
  const selectedThreadFromList = state.threadId && connectionId
    ? (state.threads.status === "ready" ? state.threads.data.items : []).find((item) =>
      item.threadId === state.threadId &&
      item.connectionId === connectionId &&
      (state.threadProjectId === null || item.projectId === state.threadProjectId),
    ) ?? null
    : null;
  // Once the detail is ready, only its fresh native status may authorize the
  // loop. The list is up to 60s old and may still say "running" after the run
  // settled; the detail is the authority for the opened thread.
  const selectedThreadStatus = selectedDetail ? selectedDetail.thread.status : selectedThreadFromList?.status ?? null;
  const activityRefreshMatchesSelection = state.activityRefresh.connectionId === connectionId &&
    state.activityRefresh.threadId === state.threadId &&
    state.activityRefresh.projectId === state.threadProjectId;
  const activityPauseReason = activityRefreshMatchesSelection && state.activityRefresh.terminal
    ? "stopped"
    : activityPollPauseReason({
      enabled,
      documentVisible,
      connected: connectionId !== null,
      threadStatus: selectedThreadStatus,
      detailReady: selectedDetail !== null,
      nextPosition: selectedDetail?.nextPosition ?? null,
    });
  const activityPolling = activityPauseReason === null;

  useEffect(() => {
    if (!enabled || !connectionId || !state.threadId || !state.threadProjectId || !activityPolling || !documentVisible) return;
    const scopedConnection = connectionId;
    const scopedProjectId = state.threadProjectId;
    const scopedThreadId = state.threadId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let failures = 0;

    const stop = () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      controller?.abort();
      controller = null;
    };
    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(() => { void tick(); }, delay);
    };

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      const live = stateRef.current;
      const liveDetail = live.detail.status === "ready" ? live.detail.data : null;
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
      const pause = activityPollPauseReason({
        enabled,
        documentVisible: visible,
        connected: activeConnectionId(live) !== null,
        threadStatus: liveDetail?.thread.status ?? null,
        detailReady: liveDetail !== null,
        nextPosition: liveDetail?.nextPosition ?? null,
      });
      if (
        pause !== null ||
        live.connectionId !== scopedConnection ||
        live.threadId !== scopedThreadId ||
        live.threadProjectId !== scopedProjectId
      ) {
        // A hidden/inactive state can recover without a new effect run (for
        // example, a slow thread status change). Keep the single timer alive
        // and re-check on the normal cadence rather than spinning.
        schedule(ACTIVITY_POLL_INTERVAL_MS);
        return;
      }
      if (activityRequest.current !== null) {
        schedule(ACTIVITY_POLL_INTERVAL_MS);
        return;
      }
      if (liveDetail === null || liveDetail.nextPosition === null) {
        schedule(ACTIVITY_POLL_INTERVAL_MS);
        return;
      }

      const { token, controller: requestController } = beginActivityRequest(scopedConnection, scopedProjectId, scopedThreadId);
      const attemptedAt = new Date().toISOString();
      controller = requestController;
      dispatch({
        type: "detail/refresh-start",
        connectionId: scopedConnection,
        projectId: scopedProjectId,
        threadId: scopedThreadId,
        attemptedAt,
      });
      try {
        const next = await adapter.readThread({
          connectionId: scopedConnection,
          threadId: scopedThreadId,
          afterPosition: liveDetail.nextPosition,
        }, requestController.signal);
        if (cancelled || requestController.signal.aborted || !ownsActivityRequest(token)) return;
        dispatch({
          type: "detail/refreshed",
          connectionId: scopedConnection,
          projectId: scopedProjectId,
          threadId: scopedThreadId,
          detail: next,
          attemptedAt,
        });
        failures = 0;
        schedule(ACTIVITY_POLL_INTERVAL_MS);
      } catch (raw) {
        if (cancelled || requestController.signal.aborted || !ownsActivityRequest(token)) return;
        const error = toUiError(raw);
        if (error.code === "access_denied") {
          // The existing access-loss contract drops every private read. A
          // background poll must not keep a transcript on screen or keep
          // retrying against a denied owner.
          dispatch({ type: "private/clear" });
          dispatch({ type: "error", error });
          return;
        }
        dispatch({
          type: "detail/refresh-failed",
          connectionId: scopedConnection,
          projectId: scopedProjectId,
          threadId: scopedThreadId,
          error,
          attemptedAt,
        });
        if (!error.retryable) {
          // Revoked/expired/malformed reads cannot be fixed by waiting. Stop
          // this loop; the owner reconnects or manually retries.
          return;
        }
        failures += 1;
        schedule(activityPollDelay(failures, error.retryAfterMs));
      } finally {
        // Only the request that still owns the slot may clear the busy flag.
        // A visibility abort or a newer selection must not leave the controls
        // stuck, and a stale request must not clear a newer request's flag.
        const ownsSlot = endActivityRequest(token);
        if (ownsSlot) dispatch({ type: "activity/in-flight", active: false });
        controller = null;
      }
    };

    activityPoll.current = { stop };
    schedule(ACTIVITY_POLL_INTERVAL_MS);
    return () => {
      stop();
      if (activityPoll.current?.stop === stop) activityPoll.current = null;
    };
  }, [
    adapter, activityPolling, beginActivityRequest, connectionId, detailNonce, documentVisible, enabled,
    endActivityRequest, ownsActivityRequest, state.threadId, state.threadProjectId,
  ]);

  /**
   * Slower summary refresh. It re-reads only the first page of a project whose
   * loaded page has no continuation cursor, so it cannot regress a cursor the
   * owner is paging. It never calls `t3_thread_read` for a row and never retries
   * a project that failed its initial read (that stays an explicit action).
   */
  const summaryPollable = enabled && connectionId !== null && documentVisible && !state.summaryRefresh.terminal && (
    state.threadView === "all-projects"
      ? state.projects.status === "ready" &&
        Object.values(state.threadPages).some((entry) => entry.status === "ready" && entry.data.nextCursor === null)
      : state.threads.status === "ready" && state.threads.data.nextCursor === null && state.projectId !== null
  );

  useEffect(() => {
    if (!summaryPollable || !connectionId) return;
    const scopedConnection = connectionId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const requests = new Set<AbortController>();

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(() => { void tick(); }, delay);
    };

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      const live = stateRef.current;
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
      if (!visible || activeConnectionId(live) !== scopedConnection) {
        schedule(SUMMARY_POLL_INTERVAL_MS);
        return;
      }
      const scope = live.threadScope;
      const view = live.threadView;
      // A selected-project summary is the same server-side query as the loaded
      // page. All-projects filters are local to loaded rows, so they are not
      // sent upstream.
      const filters = view === "selected-project"
        ? {
          ...(live.threadQuery ? { titleContains: live.threadQuery } : {}),
          ...(live.threadStatuses.length ? { statuses: live.threadStatuses } : {}),
        }
        : {};
      const targets: string[] = [];
      if (view === "all-projects") {
        if (live.projects.status !== "ready") {
          schedule(SUMMARY_POLL_INTERVAL_MS);
          return;
        }
        const CAP = 6;
        for (const project of live.projects.data.items.filter((item) => item.connectionId === scopedConnection).slice(0, CAP)) {
          const entry = live.threadPages[projectScopeKey(scopedConnection, project.projectId)];
          if (entry?.status === "ready" && entry.data.nextCursor === null) targets.push(project.projectId);
        }
      } else if (live.threads.status === "ready" && live.threads.data.nextCursor === null && live.projectId) {
        targets.push(live.projectId);
      }
      if (targets.length === 0) {
        schedule(SUMMARY_POLL_INTERVAL_MS);
        return;
      }

      dispatch({ type: "summary/refresh-start", attemptedAt: new Date().toISOString() });
      let failed = false;
      let terminal = false;
      let attempted = false;
      let lastObserved: string | null = null;
      let retryAfterMs: number | null = null;
      for (const projectId of targets) {
        if (cancelled) return;
        const key = JSON.stringify([scopedConnection, projectId]);
        if (overviewRequests.current.has(key)) continue;
        const controller = new AbortController();
        requests.add(controller);
        overviewRequests.current.set(key, controller);
        attempted = true;
        try {
          const page = await adapter.listThreads({ connectionId: scopedConnection, projectId, ...filters }, controller.signal);
          if (cancelled || controller.signal.aborted) continue;
          const latest = stateRef.current;
          if (
            activeConnectionId(latest) !== scopedConnection ||
            latest.threadScope !== scope ||
            latest.threadView !== view
          ) continue;
          dispatch({
            type: "threads/ready",
            connectionId: scopedConnection,
            projectId,
            scope,
            page,
            source: "refresh",
          });
          lastObserved = page.freshness.observedAt ?? lastObserved;
        } catch (raw) {
          if (cancelled || controller.signal.aborted) continue;
          const error = toUiError(raw);
          if (error.code === "access_denied") {
            dispatch({ type: "private/clear" });
            dispatch({ type: "error", error });
            cancelled = true;
            return;
          }
          failed = true;
          retryAfterMs = error.retryAfterMs ?? retryAfterMs;
          dispatch({ type: "summary/refresh-failed", error });
          // A revoked/expired grant or another non-retryable read cannot be
          // repaired by waiting. Stop this batch and the loop until the owner
          // acts; do not keep reading the remaining projects.
          if (!error.retryable) {
            terminal = true;
            break;
          }
        } finally {
          requests.delete(controller);
          if (overviewRequests.current.get(key) === controller) overviewRequests.current.delete(key);
        }
      }
      if (cancelled) return;
      if (terminal) return;
      if (failed) {
        failures += 1;
        schedule(summaryPollDelay(failures, retryAfterMs));
        return;
      }
      failures = 0;
      if (attempted) dispatch({ type: "summary/refresh-ok", observedAt: lastObserved });
      schedule(SUMMARY_POLL_INTERVAL_MS);
    };

    schedule(SUMMARY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      for (const controller of requests) controller.abort();
      requests.clear();
    };
  }, [adapter, connectionId, enabled, documentVisible, summaryPollable, state.threadScope, state.threadView]);

  const loadMore = useCallback((resource: Resource, run: (signal: AbortSignal) => Promise<void>, existing?: AbortController) => {
    if (state.paging[resource]) return;
    dispatch({ type: "paging", resource, active: true });
    const controller = existing ?? track();
    pagingRequests.current.set(resource, controller);
    run(controller.signal).finally(() => {
      release(controller);
      if (pagingRequests.current.get(resource) === controller) pagingRequests.current.delete(resource);
      if (!controller.signal.aborted) dispatch({ type: "paging", resource, active: false });
    });
  }, [state.paging, track, release]);

  const actions = useMemo<T3DashboardActions>(() => ({
    selectConnection: (connectionId) => {
      if (connectionId !== state.connectionId) cancelActivityReads();
      dispatch({ type: "select/connection", connectionId });
    },
    selectProject: (projectId) => {
      if (projectId !== state.projectId) cancelActivityReads();
      dispatch({ type: "select/project", projectId });
    },
    selectThread: (threadId, projectId) => {
      // Re-selecting the same thread is a no-op; it must not kill its loop.
      if (threadId !== state.threadId || projectId !== state.threadProjectId) cancelActivityReads();
      dispatch({ type: "select/thread", threadId, projectId });
    },
    reloadActivity: () => {
      // Stop the timer and abort every in-flight activity read (poll, Load more,
      // truncated text) before the manual read starts, so the two can never
      // overlap. An already-loaded selection is re-read from its native cursor;
      // a selection without a loaded page gets a full first-page read.
      cancelActivityReads();
      setDetailNonce((nonce) => nonce + 1);
    },
    setThreadView: (view) => {
      // The selected thread and its detail survive a view change, so its
      // activity loop must survive too. Only the summary loop is view-scoped.
      dispatch({ type: "thread/view", view });
    },
    setThreadStatuses: (statuses) => {
      const changed = statuses.length !== state.threadStatuses.length ||
        statuses.some((status, index) => status !== state.threadStatuses[index]);
      // A selected-project filter change clears the opened thread, so its
      // activity read must be cancelled before the new scope starts.
      if (changed && state.threadView === "selected-project") cancelActivityReads();
      dispatch({ type: "thread/statuses", statuses });
    },
    setThreadQuery: (value) => {
      setThreadQueryInput(value);
      // Debounced so typing does not fan out one T3 read per keystroke.
      if (queryTimer.current) clearTimeout(queryTimer.current);
      queryTimer.current = setTimeout(() => {
        const live = stateRef.current;
        if (value.trim() !== live.threadQuery && live.threadView === "selected-project") cancelActivityReads();
        dispatch({ type: "thread/query", query: value.trim() });
      }, 300);
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
      if (state.threadView === "selected-project" && (state.threadQuery !== "" || state.threadStatuses.length > 0)) {
        cancelActivityReads();
      }
      setThreadQueryInput("");
      dispatch({ type: "thread/query", query: "" });
      dispatch({ type: "thread/statuses", statuses: [] });
    },

    connect(endpoint, access) {
      return startConsent((signal) => adapter.startOAuth({ endpoint, access }, signal));
    },

    reconnect(connectionId, access) {
      // Reuses the existing connection id so no duplicate active grant is created.
      return startConsent((signal) => adapter.restartOAuth({ connectionId, access }, signal));
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
        // First expand project coverage, including projects whose earlier read
        // failed (an explicit load/retry is the only path that retries them).
        const unread = knownProjects.filter((project) => {
          const entry = state.threadPages[JSON.stringify([connectionId, project.projectId])];
          return !entry || entry.status === "error";
        });
        const CAP = 6;
        const batch = (unread.length > 0 ? unread : knownProjects.filter((project) => {
          const entry = state.threadPages[JSON.stringify([connectionId, project.projectId])];
          return entry?.status === "ready" && entry.data.nextCursor !== null;
        })).slice(0, CAP);
        if (batch.length === 0) return;
        // Unread projects request their first page. A project that already has a
        // cursor requests the next page. The two sets never overlap in a batch,
        // and the reducer merges by thread identity, so an overlapping upstream
        // page boundary cannot duplicate a row.
        const toFetch = batch.map((project) => {
          const key = JSON.stringify([connectionId, project.projectId]);
          const entry = state.threadPages[key];
          const cursor = entry?.status === "ready" ? entry.data.nextCursor : null;
          return { key, projectId: project.projectId, cursor };
        });
        loadMore("threads", async (signal) => {
          const isStale = () => {
            const live = lifecycleRef.current;
            return signal.aborted || live.connectionId !== scopedConnection || live.view !== "all-projects" || live.scope !== scope;
          };
          for (const { key, projectId, cursor } of toFetch) {
            // The batch is serial. A connection/view/scope change must stop it
            // before the next request is created, not after the old loop has
            // already dispatched a read under the superseded grant.
            if (isStale()) return;
            const controller = new AbortController();
            const existing = overviewRequests.current.get(key);
            if (existing) {
              controller.abort();
              continue;
            }
            overviewRequests.current.set(key, controller);
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            if (isStale()) {
              controller.abort();
              signal.removeEventListener("abort", abort);
              if (overviewRequests.current.get(key) === controller) overviewRequests.current.delete(key);
              return;
            }
            try {
              const next = await adapter.listThreads({
                connectionId: scopedConnection, projectId,
                ...(cursor !== null ? { cursor } : {}),
              }, controller.signal);
              if (!controller.signal.aborted && !isStale()) {
                dispatch({ type: "threads/ready", connectionId: scopedConnection, projectId, scope, page: next });
              }
            } catch (raw) {
              if (!controller.signal.aborted && !isStale()) {
                failRead(raw, (error) => dispatch({ type: "threads/failed", connectionId: scopedConnection, projectId, scope, error }));
              }
            } finally {
              signal.removeEventListener("abort", abort);
              if (overviewRequests.current.get(key) === controller) overviewRequests.current.delete(key);
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
      // A poll and an explicit Load more must never share the same cursor
      // concurrently. Whichever starts first owns the slot.
      if (state.paging.activity || activityRequest.current !== null) return;
      const scopedConnection = connectionId;
      const scopedProjectId = state.threadProjectId ?? "";
      const { token, controller } = beginActivityRequest(scopedConnection, scopedProjectId, threadId);
      dispatch({ type: "activity/in-flight", active: true });
      loadMore("activity", async (signal) => {
        try {
          const next = await adapter.readThread({ connectionId: scopedConnection, threadId, afterPosition }, signal);
          if (signal.aborted || !ownsActivityRequest(token)) return;
          dispatch({ type: "detail/page", connectionId: scopedConnection, threadId, detail: next });
        } catch (raw) {
          // An abort is the deliberate Refresh-takes-the-slot path, not a read
          // failure. Do not surface a false "Load more failed" error.
          if (signal.aborted || !ownsActivityRequest(token)) return;
          // A failed manual continuation keeps the items and cursor already on
          // screen. It gets its own error channel so the UI does not blame the
          // automatic poll or promise a backoff that is not running.
          failRead(raw, (error) => dispatch({
            type: "detail/page-failed",
            connectionId: scopedConnection,
            projectId: scopedProjectId,
            threadId,
            error,
          }));
        } finally {
          if (endActivityRequest(token)) dispatch({ type: "activity/in-flight", active: false });
        }
      }, controller);
    },

    loadTruncatedText(item) {
      const threadId = state.threadId;
      if (!connectionId || !threadId) return;
      const offset = item.nextTextOffset ?? null;
      if (offset === null) {
        dispatch({ type: "error", error: { code: "not_found", message: "T3 did not return a further text offset for that item.", retryable: false } });
        return;
      }
      // A continuation is another t3_thread_read. It shares the single activity
      // slot so it cannot overlap the poll for the same thread.
      if (activityRequest.current !== null) return;
      const scopedConnection = connectionId;
      const scopedProjectId = state.threadProjectId ?? "";
      const { token, controller } = beginActivityRequest(scopedConnection, scopedProjectId, threadId);
      dispatch({ type: "activity/in-flight", active: true });
      adapter.loadTruncatedText({
        connectionId: scopedConnection,
        projectId: scopedProjectId,
        threadId,
        itemId: item.id,
        textOffset: offset,
      }, controller.signal)
        .then((continuation) => {
          if (!controller.signal.aborted && ownsActivityRequest(token)) dispatch({
            type: "detail/continuation",
            connectionId: scopedConnection,
            projectId: scopedProjectId,
            threadId,
            item: continuation,
          });
        })
        .catch((raw) => {
          if (controller.signal.aborted || !ownsActivityRequest(token)) return;
          failRead(raw, (error) => dispatch({ type: "error", error: { ...error, message: messageFor(error) } }));
        })
        .finally(() => {
          if (endActivityRequest(token)) dispatch({ type: "activity/in-flight", active: false });
        });
    },

    applyCallbackStatus(status, outcome) {
      if (!callbackStatuses.includes(status as (typeof callbackStatuses)[number])) return;
      if (status === "connected") {
        // The backend reports the tier it actually saved. The inventory read
        // that follows must still confirm a connected row of that tier before
        // the reducer selects it.
        if (outcome?.access === "read-only" || outcome?.access === "operate" || outcome?.access === "full-access") {
          pendingSelection.current = outcome.access;
        }
        dispatch({ type: "oauth/reset" });
        dispatch({ type: "notice", message: "T3 connected. Verifying the environment…" });
        setInventoryVersion((value) => value + 1);
        return;
      }
      if (status === "denied") dispatch({ type: "oauth/denied" });
      else if (status === "expired") dispatch({ type: "oauth/expired" });
      else {
        const message = scopeFailureMessage(outcome?.reason) ??
          "The T3 connection could not be completed. No access was granted.";
        dispatch({ type: "error", error: { code: "callback_failed", message, retryable: true } });
      }
      setInventoryVersion((value) => value + 1);
    },
  }), [adapter, beginActivityRequest, cancelActivityReads, connectionId, endActivityRequest, failRead, loadMore, ownsActivityRequest, release, startConsent, state, track]);

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
    detailPageError: state.detailPageError,
    activityReadInFlight: state.activityReadInFlight,
    activityRefresh: state.activityRefresh,
    summaryRefresh: state.summaryRefresh,
    activityPauseReason,
    live: true,
  };
}