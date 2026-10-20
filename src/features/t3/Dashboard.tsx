"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { threadDetailKey, type AccessLevel, type Activity, type ConnectionRecord, type DashboardData, type Freshness, type ReadState } from "./contract";
import { fixturesEnabled } from "./fixture-gate";
import type { FixtureScenario } from "./fixtures";
import { useT3Dashboard, type T3DashboardController } from "./useT3Dashboard";
import { accessLevels, backendUnavailable, connectActionLabel, connectActionPending, connectionCopy, filterProjects, filterThreads, threadReference, validateEndpoint } from "./ui";
import { ConnectionAccessChoice } from "./ConnectionAccessChoice";
import { FollowUpControl } from "./FollowUpControl";
import { InterruptControl } from "./InterruptControl";
import { AttentionBadge } from "./AttentionBadge";
import { VerifiedPullRequestPanel } from "./VerifiedPullRequestPanel";
import { isLiveRun } from "../../../convex/lib/runStatus";
import styles from "./Dashboard.module.css";

const navigation = [
  ["overview", "Overview", "◈"], ["connect", "Connect T3", "↗"],
  ["environments", "Environments", "▣"], ["projects", "Projects", "▤"],
  ["providers", "Providers & models", "◇"], ["threads", "Threads", "≋"],
] as const;
const featureLabels = [
  ["appOwnedSubagents", "App-owned subagents"], ["asyncPolling", "Asynchronous polling"],
  ["cancellation", "Cancellation"], ["batchThreadCreation", "Batch thread creation"],
  ["threadManagement", "Thread management"], ["incrementalThreadRead", "Incremental thread reads"],
  ["scheduledTasks", "Scheduled tasks"], ["maxBatchThreads", "Maximum batch threads"],
] as const;

function UnavailableAction({ children, type = "button" }: { children: ReactNode; type?: "button" | "submit" }) {
  return <button type={type} className={styles.button} disabled aria-describedby="t3-execution-disabled">{children}</button>;
}
/**
 * An enabled action, shown only when the live controller backs it.
 *
 * `type` defaults to `"button"` so a button that happens to be nested in a
 * `<form>` can never implicitly submit it. The Connect control is the single
 * exception and passes `type="submit"` explicitly, because form submission is
 * the only path that starts a native T3 consent flow — it covers both mouse
 * clicks and pressing Enter in the endpoint field.
 */
function LiveAction({ children, onClick, type = "button", busy = false }: { children: ReactNode; onClick?: () => void; type?: "button" | "submit"; busy?: boolean }) {
  return <button type={type} className={styles.button} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>{children}</button>;
}
function ReadNotice({ state, empty, preview }: { state: ReadState<unknown>; empty: string; preview?: boolean }) {
  if (state.status === "loading") {
    const label = `Loading ${empty.replace(/ unavailable$/, "").toLowerCase()}…`;
    return <div className={styles.loading} role="status"><span className={styles.srOnly}>{label}</span><span className={styles.skeleton} aria-hidden="true"><i /><i /><i /></span></div>;
  }
  if (state.status === "error") return <p className={styles.empty} role="alert">{state.error.message}</p>;
  return <p className={styles.empty}>{empty}. {preview ? backendUnavailable : "Not read from T3 yet."}</p>;
}
function FreshnessNote({ freshness }: { freshness: Freshness }) {
  const source = freshness.source === "fixture" ? "Sample data" : freshness.source === "backend" ? "Backend snapshot" : "Source unavailable";
  return <p className={styles.freshness}>{source} · {freshness.stale ? "Stale — refresh required" : freshness.observedAt ? `Observed ${freshness.observedAt}` : "Freshness unknown"}</p>;
}
/**
 * One activity item. Truncated text is extended only when T3 actually returned a
 * further offset, so the UI never implies content it has not received.
 */
function ActivityEntry({ item, live }: { item: Activity; live?: T3DashboardController }) {
  return <li>
    <span>{item.kind ?? "Unknown activity"} · {item.createdAt ?? "Time unknown"}</span>
    <p>{item.text ?? "Content unavailable"}</p>
    {item.truncated && (live && item.nextTextOffset !== null && item.nextTextOffset !== undefined
      ? <button className={styles.button} onClick={() => void live.actions.loadTruncatedText(item)}>Load more text</button>
      : <p className={styles.help}>Truncated content. Load the continuation from T3.</p>)}
  </li>;
}
function MetadataRow({ label, value }: { label: string; value?: string | null }) {
  return <div><dt>{label}</dt><dd>{value ?? "Unknown"}</dd></div>;
}
function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2></div>{children}</div>;
}

/**
 * Pure frontend view. `controller` is supplied only when real backend reads are
 * driving it; a fixture preview renders the same markup with the connection
 * controls still natively disabled.
 */
export function DashboardView({ data: providedData, controller, preview = false, accountControls, previewControls, serviceStatus }: {
  data: DashboardData; controller?: T3DashboardController; preview?: boolean; accountControls?: ReactNode; previewControls?: ReactNode; serviceStatus?: ReactNode;
}) {
  const live = controller;
  const data = live?.data ?? providedData;
  const [activeSection, setActiveSection] = useState("overview");
  const [endpoint, setEndpoint] = useState("");
  const [touched, setTouched] = useState(false);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("read-only");
  const [projectSearch, setProjectSearch] = useState("");
  const [localThreadSearch, setLocalThreadSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [localConnectionId, setLocalConnectionId] = useState<string | null>(null);
  const [localProjectId, setLocalProjectId] = useState<string | null>(null);
  const [localThreadId, setLocalThreadId] = useState<string | null>(null);
  const [localThreadView, setLocalThreadView] = useState<"selected-project" | "all-projects">("selected-project");
  const [copyStatus, setCopyStatus] = useState("");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  useEffect(() => {
    const syncActiveSection = () => {
      const hash = window.location.hash.slice(1);
      setActiveSection(navigation.some(([id]) => id === hash) ? hash : "overview");
    };
    syncActiveSection();
    window.addEventListener("hashchange", syncActiveSection);
    return () => window.removeEventListener("hashchange", syncActiveSection);
  }, []);

  // In live mode the controller owns the selection, so the view never keeps a
  // second authoritative copy of the selected connection, project or thread.
  const selectedConnectionId = live ? live.selection.connectionId : localConnectionId;
  const selectedProjectId = live ? live.selection.projectId : localProjectId;
  const selectedThreadId = live ? live.selection.threadId : localThreadId;
  const threadSearch = live ? live.threadQueryInput : localThreadSearch;
  const threadView = live ? live.threadView : localThreadView;
  const resetDependents = useCallback(() => {
    if (!live) {
      setLocalProjectId(null);
      setLocalThreadId(null);
    }
    setProjectFilter("");
    setCopyStatus("");
  }, [live]);
  const selectConnection = useCallback((connectionId: string) => {
    if (live) live.actions.selectConnection(connectionId);
    else setLocalConnectionId(connectionId);
    setAccessLevel("read-only");
    resetDependents();
    if (!live) {
      setLocalProjectId(null);
      setLocalThreadId(null);
    }
  }, [live, resetDependents]);
  const selectProject = useCallback((projectId: string) => {
    if (live) {
      const changing = live.selection.projectId !== projectId;
      live.actions.selectProject(projectId);
      // Filters belong to a project. Leaving the previous project's query and
      // status selection in place would hide threads in the new one. Re-selecting
      // the project already on screen must not discard the owner's own search.
      if (changing) live.actions.clearThreadFilters();
    } else setLocalProjectId(projectId);
    setCopyStatus("");
    if (!live) setLocalThreadId(null);
  }, [live]);
  const selectThread = useCallback((threadId: string, projectId: string | null = null) => {
    if (live) live.actions.selectThread(threadId, projectId);
    else setLocalThreadId(threadId);
    setCopyStatus("");
  }, [live]);
  const changeThreadSearch = useCallback((value: string) => {
    if (live) live.actions.setThreadQuery(value);
    else setLocalThreadSearch(value);
    setCopyStatus("");
  }, [live]);
  const changeThreadView = useCallback((value: "selected-project" | "all-projects") => {
    if (live) live.actions.setThreadView(value);
    else setLocalThreadView(value);
    setCopyStatus("");
  }, [live]);

  const validation = validateEndpoint(endpoint);
  const copy = data.connection.status === "connected" && preview
    ? { title: "Connected · sample", description: "Simulated connection for development preview. Helm has not connected to T3." }
    : connectionCopy[data.connection.status];
  const environments = data.environments.status === "ready" ? data.environments.data.items : [];
  const selectedEnvironment = environments.find(({ connection }) => connection.connectionId === selectedConnectionId) ?? environments[0];
  const activeConnectionId = selectedEnvironment?.connection.status === "connected" ? selectedEnvironment.connection.connectionId : null;
  const allProjects = data.projects.status === "ready" ? data.projects.data.items : [];
  const allThreads = data.threads.status === "ready" ? data.threads.data.items : [];
  const projects = activeConnectionId ? allProjects.filter((item) => item.connectionId === activeConnectionId) : [];
  const threads = activeConnectionId ? allThreads.filter((item) => item.connectionId === activeConnectionId) : [];
  const visibleProjects = filterProjects(projects, projectSearch);
  const visibleThreads = filterThreads(threads, threadSearch, projectFilter);
  const project = visibleProjects.find((item) => item.projectId === selectedProjectId) ?? visibleProjects[0];
  // The detail read is separate from the list so one can succeed while the other fails.
  const projectDetail = data.projectDetail;
  const matchedThread = visibleThreads.find((item) => item.threadId === selectedThreadId);
  // Live mode never pre-selects a thread: `t3_thread_read` waits for the owner.
  const thread = live ? matchedThread ?? null : matchedThread ?? visibleThreads[0];
  const detail = thread ? data.details[threadDetailKey(thread.connectionId, thread.projectId, thread.threadId)] : undefined;
  const threadConnection = thread
    ? environments.find(({ connection }) => connection.connectionId === thread.connectionId)?.connection ??
      (data.connection.status === "connected" && data.connection.connection.connectionId === thread.connectionId ? data.connection.connection : null)
    : null;
  const canOperateSelected = threadConnection?.access === "operate";
  // The run an interrupt would target. Selected from VERIFIED run information —
  // a run whose native status classifies as live — not from array position, so a
  // completed run sitting last can never be offered as interruptible.
  //
  // If more than one run is live we refuse to pick one: choosing would be the
  // same arbitrary-position guess in disguise, and interrupting the wrong run is
  // exactly what EGA-765 exists to prevent. The owner is told to choose in T3.
  const observedRuns = detail && detail.status === "ready" ? detail.data.recentRuns : [];
  const liveRuns = observedRuns.filter((run) => isLiveRun(run.status));
  const liveRunAmbiguous = liveRuns.length > 1;
  const activeRun = liveRuns.length === 1 ? liveRuns[0] : null;
  const activeRunId = activeRun?.runId ?? null;
  const activeRunStatus = activeRun?.status ?? null;
  const catalog = data.catalog.status === "ready" ? data.catalog.data : null;
  const connected = data.connection.status === "connected";
  const savedConnection = data.connection.status === "connected" || data.connection.status === "revoked" ||
    data.connection.status === "unreachable" || data.connection.status === "expired" ? data.connection.connection : null;
  const scopedProjectLabel = project?.title ?? project?.projectId ?? "No project selected";

  function startConnection(request: () => void) {
    setConfirmingDisconnect(null);
    request();
  }

  /** Confirm-then-act disconnect: never triggered by navigation or a test. */
  function connectionControls(connection: ConnectionRecord) {
    if (!live) return <div className={styles.actions}><UnavailableAction>Reconnect</UnavailableAction><UnavailableAction>Disconnect</UnavailableAction></div>;
    if (confirmingDisconnect !== connection.connectionId) {
      return <div className={styles.actions}>
        <LiveAction onClick={() => { void live.actions.reconnect(connection.connectionId, connection.access === "operate" ? "operate" : undefined); }} busy={live.busy === "starting"}>Reconnect</LiveAction>
        <LiveAction onClick={() => void live.actions.refresh(connection.connectionId)} busy={live.busy === "refreshing"}>Refresh connection</LiveAction>
        <LiveAction onClick={() => { setCopyStatus(""); setConfirmingDisconnect(connection.connectionId); }}>Disconnect</LiveAction>
      </div>;
    }
    return <div className={styles.actions} role="group" aria-label={`Confirm disconnect ${connection.displayName ?? connection.connectionId}`}>
      <p className={styles.help}>This removes the saved T3 grant for this connection. Reconnecting needs a new approval at T3.</p>
      <LiveAction onClick={() => void live.actions.disconnect(connection.connectionId)} busy={live.busy === "disconnecting"}>Confirm disconnect</LiveAction>
      <button type="button" className={styles.button} onClick={() => setConfirmingDisconnect(null)}>Cancel disconnect</button>
    </div>;
  }

  async function copyReference() {
    if (!thread) return;
    try {
      await navigator.clipboard.writeText(threadReference(thread.threadId));
      setCopyStatus("T3 reference copied.");
    } catch {
      setCopyStatus("Clipboard unavailable. Select and copy the reference below.");
    }
  }

  return (
    <div className={styles.dashboard}>
      <a className={styles.skipLink} href="#overview" onClick={() => setActiveSection("overview")}>Skip to dashboard content</a>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="#overview" onClick={() => setActiveSection("overview")} aria-label="Helm overview"><span className={styles.brandMark} aria-hidden="true">H</span>helm<span className={styles.privateBadge}>PRIVATE</span></a>
        <p className={styles.navLabel}>WORKSPACE</p>
        <nav aria-label="Workspace navigation" className={styles.navigation}>
          {navigation.map(([id, label, icon]) => <a key={id} href={`#${id}`} aria-current={activeSection === id ? "location" : undefined} onClick={() => setActiveSection(id)}><span aria-hidden="true">{icon}</span>{label}</a>)}
        </nav>
        <div className={styles.sidebarFooter}><span className={styles.ownerDot} aria-hidden="true" /><div><strong>Owner workspace</strong><p>Private owner dashboard</p></div></div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}><span>Workspace <span aria-hidden="true">/</span> <strong>{navigation.find(([id]) => id === activeSection)?.[1] ?? "Overview"}</strong></span><div className={styles.account}>{accountControls}</div></header>
        <div className={styles.content}>
          <section id="overview" tabIndex={-1} className={styles.overview} aria-label="Overview">
            <div className={styles.hero}><div><p className={styles.eyebrow}>YOUR EXECUTION WORKSPACE</p><h2>Everything in view.<br /><span>You at the helm.</span></h2><p>One place to understand your T3 environments,<br className={styles.desktopBreak} /> projects, and the work moving through them.</p></div><a href="#connect" onClick={() => setActiveSection("connect")} className={styles.primaryLink}>Explore connection <span aria-hidden="true">↗</span></a></div>
            <div className={styles.notice} id="t3-connection-notice"><span aria-hidden="true">○</span><div><strong>{preview ? "Development fixture preview — no live T3 connection" : connected ? "T3 authorization verified by the backend" : live ? "No verified T3 connection yet" : "T3 backend integration is not available yet"}</strong><p>{preview || !connected ? `${live ? "Sign in at T3 to read environments, projects and threads." : backendUnavailable} Local browsing and URL validation are available.` : "T3 remains the source of truth for project, catalog, and thread data."}</p></div></div>
              <p className={styles.help} id="t3-execution-disabled">Helm can read T3. Native follow-up and interrupt require an operate-authorised connection; thread launch is not available from Helm. Linear status sync and verified PR checks are not implemented yet, so those remain unavailable.</p>
            {live?.notice && <p className={styles.help} role="status">{live.notice}</p>}
            {live?.error && <p className={styles.error} role="alert">{live.error.message}</p>}
            {previewControls}
            <div className={styles.metrics}>
              <div><span>T3 connection</span><strong className={styles.metricText}>{connected ? preview ? "Sample connected" : "Connected" : data.connection.status === "not-connected" ? "Not connected" : data.connection.status[0].toUpperCase() + data.connection.status.slice(1)}</strong><small>{preview ? "Simulated state only" : connected ? "Verified by backend" : live ? "No verified authorization" : "No authorization started"}</small></div>
              <div><span>Environments</span><strong>{data.environments.status === "ready" ? environments.length : "—"}</strong><small>{preview ? "In this sample" : "Saved connections"}</small></div>
              <div><span>Projects</span><strong>{data.projects.status === "ready" ? projects.length : "—"}</strong><small>{preview ? "In the loaded sample page" : "In the loaded pages"}</small></div>
              <div><span>Threads</span><strong>{data.threads.status === "ready" ? threads.length : "—"}</strong><small>{preview ? "In the loaded sample page" : project ? `In ${project.title ?? project.projectId}` : "Select a project"}</small></div>
            </div>
          </section>

          <section id="connect" className={styles.section} aria-label="Connect T3">
            <SectionTitle eyebrow="01 / CONNECTION" title="Connect your workspace"><span className={styles.badge}>{preview ? `Sample: ${data.connection.status}` : data.connection.status === "connected" ? "Connected" : data.connection.status === "pending" ? "Authorization pending" : data.connection.status === "failed" ? "Connection failed" : data.connection.status === "expired" ? "Expired" : data.connection.status === "denied" ? "Consent denied" : "Not connected"}</span></SectionTitle>
            <div className={styles.connectionGrid}>
              <div className={styles.panel}>
                <div className={styles.connectionIcon} aria-hidden="true">↗</div><h3>{copy.title}</h3><p>{copy.description}</p>
                {data.connection.status === "failed" && <p role="alert" className={styles.error}>{data.connection.error.message}</p>}
                {data.connection.status === "pending" && <p role="status">{preview ? "Sample approval request pending." : "Approval request pending."} {data.connection.expiresAt ? `Request expires ${data.connection.expiresAt}.` : "Request expiry unknown."}</p>}
                {savedConnection ? <>
                  <dl className={styles.metadata}><MetadataRow label="Connection name" value={savedConnection.displayName} /><MetadataRow label="Environment identity" value={savedConnection.environmentId} /><MetadataRow label="MCP endpoint" value={savedConnection.endpoint} /><MetadataRow label="Approved access" value={accessLevels.find((level) => level.id === savedConnection.access)?.title} /><MetadataRow label="Last verified" value={savedConnection.lastVerifiedAt} /><MetadataRow label="Last read" value={savedConnection.lastReadAt} /><MetadataRow label="Connection error" value={savedConnection.errorCode} /><MetadataRow label="Approval expires" value={savedConnection.expiresAt} /></dl>
                  {connectionControls(savedConnection)}
                  <p className={styles.help}>Access level: {accessLevels.find((level) => level.id === savedConnection.access)?.title ?? "Unknown"}. Reconnecting keeps this level. To change it, create a new connection.</p>
                  {!connected && <p className={styles.help}>This connection is not authorized right now. Reconnect to approve a new sign-in at T3.</p>}
                </> : <form onSubmit={(event) => { event.preventDefault(); if (live && validation.valid) { startConnection(() => void live.actions.connect(validation.endpoint, accessLevel)); } }} noValidate>
                  <label htmlFor="t3-endpoint">T3 MCP endpoint</label><input id="t3-endpoint" type="url" placeholder="https://your-environment/mcp" value={endpoint} autoComplete="off" spellCheck={false} aria-describedby="t3-endpoint-help t3-endpoint-validation" aria-invalid={touched && !validation.valid} onChange={(event) => { setEndpoint(event.target.value); setTouched(true); }} onBlur={() => setTouched(true)} />
                  <p id="t3-endpoint-help" className={styles.help}>Copy the native /mcp URL from T3 Settings → Connections. {live ? "The Helm backend must be able to reach it." : "Helm’s future backend must be able to reach it."}</p>
                  <p id="t3-endpoint-validation" className={touched && !validation.valid ? styles.error : styles.help} aria-live="polite">{touched ? validation.valid ? "URL format looks valid. Reachability has not been checked." : validation.message : live ? "Validation is local. Submitting starts a native T3 consent flow." : "URL validation is local. This form never sends a request."}</p>
                  <ConnectionAccessChoice value={accessLevel} onChange={setAccessLevel} disabled={!live} />
                  {live
                    ? <LiveAction type="submit" busy={live.busy === "starting" || connectActionPending(data.connection)}>{connectActionLabel(data.connection)}</LiveAction>
                    : <UnavailableAction type="button">{connectActionLabel(data.connection)}</UnavailableAction>}
                </form>}
              </div>
              <div className={styles.explainer}><p className={styles.eyebrow}>YOU CHOOSE THE ACCESS</p><h3>Approval lives at T3.</h3><p>Helm sign-in and T3 consent are separate. You choose the permission level on T3’s sign-in page.</p><ol className={styles.steps}><li><span>1</span>Copy your environment’s MCP URL.</li><li><span>2</span>Approve a sign-in you started at T3.</li><li><span>3</span>Review the environment and access scope.</li></ol><p className={styles.help}>An approved sign-in expires after 30 days. Revoke access anytime in T3 Settings → Connections.</p></div>
            </div>
            <div className={styles.accessGrid}>{accessLevels.map((level, index) => <article key={level.id}><span className={styles.accessNumber}>0{index + 1}</span><h3>{level.title}{index === 0 && <span className={styles.recommended}>Default</span>}</h3><p>{level.description}</p></article>)}</div>
          </section>

          <section id="environments" className={styles.section} aria-label="Environments">
            <SectionTitle eyebrow="02 / ENVIRONMENTS" title="Where your work runs" />
            {data.environments.status !== "ready" ? <ReadNotice state={data.environments} empty="Environments unavailable" preview={preview} /> : environments.length === 0 ? <p className={styles.empty}>No environments returned. A connection alone does not confirm environment identity.</p> : <><div className={styles.environmentGrid}>{environments.map(({ connection, environment }) => {
              const selected = selectedEnvironment?.connection.connectionId === connection.connectionId;
              const statusLabel = connection.status[0].toUpperCase() + connection.status.slice(1);
              return <article className={`${styles.environmentCard} ${selected ? styles.environmentSelected : ""}`} key={connection.connectionId}>
                <button className={styles.environmentSelect} aria-label={`Select ${connection.displayName ?? environment?.label ?? "unnamed"} environment`} aria-pressed={selected} onClick={() => selectConnection(connection.connectionId)}>
                  <span className={styles.environmentIcon} aria-hidden="true">▣</span><span><strong>{connection.displayName ?? environment?.label ?? "Unnamed environment"}</strong><small>{connection.environmentId ?? environment?.environmentId ?? "Environment identity unknown"}</small></span>
                </button>
                <span className={`${styles.badge} ${styles[`status_${connection.status}`]}`}>{preview ? `Sample · ${statusLabel}` : statusLabel}</span>
                <dl className={styles.metadata}>
                  <MetadataRow label="Environment identity" value={connection.environmentId ?? environment?.environmentId} />
                  <MetadataRow label="MCP endpoint" value={connection.endpoint} />
                  <MetadataRow label="Permission" value={accessLevels.find((level) => level.id === connection.access)?.title} />
                  <MetadataRow label="Connection status" value={statusLabel} />
                  <MetadataRow label="Last verified" value={connection.lastVerifiedAt} />
                  <MetadataRow label="Last read" value={connection.lastReadAt} />
                  <MetadataRow label="Connection error" value={connection.errorCode} />
                  <MetadataRow label="Approval expires" value={connection.expiresAt} />
                  <MetadataRow label="Platform" value={environment?.platform} />
                  <MetadataRow label="Server version" value={environment?.serverVersion} />
                </dl>
                {connectionControls(connection)}
              </article>;
            })}</div><FreshnessNote freshness={data.environments.data.freshness} /><p className={styles.help}>Selected environment: {selectedEnvironment?.connection.displayName ?? selectedEnvironment?.environment?.label ?? "Unknown"}. Project and thread lists are scoped to this environment.</p></>}
          </section>

          <section id="projects" className={styles.section} aria-label="Projects">
            <SectionTitle eyebrow="03 / PROJECTS" title="A home for every project" />
            <div className={styles.toolbar}><label htmlFor="project-search">Search projects</label><input id="project-search" type="search" placeholder="Search name, workspace, or ID…" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></div>
            {!activeConnectionId ? <p className={styles.empty}>Select a connected environment to browse its projects.</p> : data.projects.status !== "ready" ? <ReadNotice state={data.projects} empty="Projects unavailable" preview={preview} /> : projects.length === 0 ? <p className={styles.empty}>No projects returned for this environment.</p> : <>
              <p className={styles.help} role="status">{visibleProjects.length} matching projects in this loaded page{data.projects.data.total === null ? "" : ` of ${data.projects.data.total} reported by T3`}.</p>
              <div className={styles.split}><ul className={styles.itemList} aria-label="Project list">{visibleProjects.map((item) => <li key={`${item.connectionId}:${item.projectId}`}><button aria-pressed={project?.projectId === item.projectId} onClick={() => selectProject(item.projectId)}><span className={styles.listIcon} aria-hidden="true">▤</span><span><strong>{item.title ?? "Untitled project"}</strong><small>{item.workspaceRoot ?? "Workspace unknown"}</small></span><span aria-hidden="true">→</span></button></li>)}</ul><div className={styles.detail}>{project ? <><p className={styles.eyebrow}>PROJECT DETAILS{preview ? " · SAMPLE" : ""}</p><h3>{projectDetail.status === "ready" ? projectDetail.data.title ?? "Untitled project" : project.title ?? "Untitled project"}</h3><dl className={styles.metadata}><MetadataRow label="Project ID" value={project.projectId} /><MetadataRow label="Status" value={projectDetail.status === "ready" ? projectDetail.data.status : project.status} /><MetadataRow label="Environment" value={projectDetail.status === "ready" ? projectDetail.data.environmentId : project.environmentId} /><MetadataRow label="Workspace" value={projectDetail.status === "ready" ? projectDetail.data.workspaceRoot : project.workspaceRoot} /><MetadataRow label="Repository" value={projectDetail.status === "ready" ? projectDetail.data.repositoryIdentity : project.repositoryIdentity} /><MetadataRow label="Default model" value={projectDetail.status === "ready" ? projectDetail.data.defaultModel : project.defaultModel} /></dl>{live && projectDetail.status === "loading" ? <p className={styles.help} role="status">Reading project detail from T3…</p> : live && projectDetail.status === "error" ? <p className={styles.error} role="alert">{projectDetail.error.message}</p> : null}<a href="#threads" onClick={() => { selectProject(project.projectId); setProjectFilter(project.projectId); setActiveSection("threads"); setCopyStatus(""); }} className={styles.textLink}>Browse this project’s threads →</a></> : <p>No matching projects. Try a different search.</p>}</div></div>
              <FreshnessNote freshness={data.projects.data.freshness} /><p className={styles.help}>Search covers loaded pages only. Project pages may shift between snapshots.</p>{data.projects.data.nextCursor !== null && (live ? <LiveAction onClick={() => void live.actions.loadMoreProjects()} busy={live.paging.projects}>Load more projects</LiveAction> : <UnavailableAction>Load more projects</UnavailableAction>)}
            </>}
          </section>

          <section id="providers" className={styles.section} aria-label="Providers and models">
            <SectionTitle eyebrow="04 / PROVIDER CATALOG" title="Know what’s available" />
            {!catalog ? <ReadNotice state={data.catalog} empty="Provider catalog unavailable" preview={preview} /> : <><p className={styles.help}>Runtime mode: {catalog.runtimeMode ?? "Unknown"} · Interaction mode: {catalog.interactionMode ?? "Unknown"}. Advertised models do not prove availability.</p><div className={styles.providerGrid}>{catalog.providers.length === 0 && <p className={styles.empty}>No providers advertised.</p>}{catalog.providers.map((provider) => <article className={styles.panel} key={provider.providerInstanceId}><div className={styles.providerHeading}><h3>{provider.displayName ?? provider.providerInstanceId}</h3><span className={`${styles.badge} ${provider.availability === "unavailable" ? styles.status_expired : ""}`}>{provider.availability === "unavailable" ? "Unavailable" : provider.availability === "available" ? preview ? "Sample available" : "Available" : "Availability unknown"}</span></div><p className={styles.help}>{provider.providerInstanceId} · {provider.driverKind ?? "Driver unknown"}</p><dl className={styles.metadata}><MetadataRow label="Authentication" value={provider.authenticationStatus ?? "Unknown"} /><MetadataRow label="Child tasks" value={provider.canRunChildTask == null ? null : String(provider.canRunChildTask)} /><MetadataRow label="Cross-provider tasks" value={provider.canRunCrossProviderChildTask == null ? null : String(provider.canRunCrossProviderChildTask)} /></dl>{provider.models === null ? <p>Model catalog unknown.</p> : provider.models.length === 0 ? <p>No models advertised.</p> : <ul className={styles.models}>{provider.models.map((model) => <li key={model.id}><strong>{model.label ?? model.id}</strong><code>{model.id}</code><small>{model.options == null ? "Options unknown" : `${model.options.length} advertised option descriptors`}</small></li>)}</ul>}<p className={styles.help}>Runtime modes: {provider.runtimeModes?.join(", ") ?? "Not specified"}</p>{provider.constraints?.map((constraint) => <p key={constraint} className={styles.help}>{constraint}</p>)}</article>)}</div><details className={styles.features}><summary>Orchestration features</summary>{catalog.features ? <dl className={styles.metadata}>{Object.entries(catalog.features).map(([name, value]) => <MetadataRow key={name} label={featureLabels.find(([key]) => key === name)?.[1] ?? name} value={value == null ? null : String(value)} />)}</dl> : <p>Features unknown. No support is assumed.</p>}</details><FreshnessNote freshness={catalog.freshness} /></>}
          </section>

          <section id="threads" className={styles.section} aria-label="Threads">
            <SectionTitle eyebrow="05 / THREAD ACTIVITY" title="Follow the work"><UnavailableAction>Start thread</UnavailableAction></SectionTitle>
            <div className={styles.toolbar}><div><label>Thread scope</label><div role="group" aria-label="Thread scope"><button type="button" className={styles.button} aria-pressed={threadView === "selected-project"} onClick={() => changeThreadView("selected-project")}>Selected project</button><button type="button" className={styles.button} aria-pressed={threadView === "all-projects"} onClick={() => changeThreadView("all-projects")}>All projects</button></div></div><div><label htmlFor="thread-search">Search threads</label><input id="thread-search" type="search" placeholder="Search title, status, or model…" value={threadSearch} onChange={(event) => changeThreadSearch(event.target.value)} /></div><div><label htmlFor="thread-status">Status</label>{live ? <select id="thread-status" value={live.threadStatuses[0] ?? ""} onChange={(event) => live.actions.setThreadStatuses(event.target.value ? [event.target.value] : [])}><option value="">All statuses</option>{live.observedThreadStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select> : <select id="thread-status" disabled value=""><option value="">Not available</option></select>}</div><div><label htmlFor="thread-project">Project</label>{live
                ? (threadView === "all-projects"
                    ? <><input id="thread-project" readOnly value="All projects" aria-describedby="thread-scope-help" /><p className={styles.help} id="thread-scope-help">Threads are read across every loaded project.</p></>
                    : <><input id="thread-project" readOnly value={scopedProjectLabel} aria-describedby="thread-scope-help" /><p className={styles.help} id="thread-scope-help">Threads are read for the selected project only.</p></>)
                : <select id="thread-project" value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setCopyStatus(""); }}><option value="">All loaded projects</option>{projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.title ?? item.projectId}</option>)}</select>}</div></div>
            {!activeConnectionId ? <p className={styles.empty}>Select a connected environment to browse its threads.</p> : data.threads.status !== "ready" ? <ReadNotice state={data.threads} empty="Threads unavailable" preview={preview} /> : threads.length === 0 ? <p className={styles.empty}>No threads returned{project ? ` for ${project.title ?? project.projectId}` : ""}. Start a thread in T3; thread launch from Helm is unavailable.</p> : <><p role="status" className={styles.help}>{visibleThreads.length} matching threads in this loaded page{data.threads.data.total === null ? "" : ` of ${data.threads.data.total} reported by T3`}.{live && threadView === "selected-project" ? ` Threads are read for ${project?.title ?? project?.projectId ?? "the selected project"} only.` : ""}{live && threadView === "all-projects" ? ` Threads are read across all loaded projects.` : ""}</p>
            {live && threadView === "all-projects" && (
              <p role="status" className={styles.help}>
                Threads from {Object.values(live.threadPages).filter((entry) => entry.status === "ready").length} of {projects.length} projects loaded
                {Object.values(live.threadPages).filter((entry) => entry.status === "ready").length < projects.length
                  ? " — load more projects"
                  : Object.values(live.threadPages).some((entry) => entry.status === "ready" && entry.data.nextCursor !== null)
                    ? " — load more threads"
                    : ""}.
              </p>
            )}<div className={styles.split}><ul className={styles.itemList} aria-label="Thread list">{visibleThreads.map((item) => <li key={`${item.connectionId}:${item.projectId}:${item.threadId}`}><button aria-pressed={thread?.threadId === item.threadId && thread?.projectId === item.projectId && thread?.connectionId === item.connectionId} onClick={() => selectThread(item.threadId, item.projectId)}><span className={styles.listIcon} aria-hidden="true">≋</span><span><strong>{item.title ?? "Untitled thread"}</strong><small>{item.status ?? "Status unknown"} · {projects.find((p) => p.projectId === item.projectId)?.title ?? item.projectId} · {environments.find((e) => e.connection.connectionId === item.connectionId)?.connection.displayName ?? item.connectionId} · {item.updatedAt ?? "Activity time unknown"}</small></span></button></li>)}</ul><div className={styles.detail}>{thread ? <><p className={styles.eyebrow}>THREAD DETAILS{preview ? " · SAMPLE" : ""}</p><h3>{thread.title ?? "Untitled thread"}</h3><dl className={styles.metadata}><MetadataRow label="Thread ID" value={thread.threadId} /><MetadataRow label="Status" value={thread.status} /><MetadataRow label="Last activity" value={thread.updatedAt} /><MetadataRow label="Provider" value={thread.providerInstanceId} /><MetadataRow label="Model" value={thread.model} /><MetadataRow label="Runtime mode" value={thread.runtimeMode} /><MetadataRow label="Interaction mode" value={thread.interactionMode} /><MetadataRow label="Branch" value={thread.branch} /><MetadataRow label="Worktree" value={thread.worktreePath} /></dl><AttentionBadge key={`attention:${thread.connectionId}:${thread.projectId}:${thread.threadId}`} connectionId={thread.connectionId} projectId={thread.projectId} threadId={thread.threadId} />{live && !preview ? <VerifiedPullRequestPanel key={`pull-request:${thread.connectionId}:${thread.threadId}`} connectionId={thread.connectionId} threadId={thread.threadId} /> : null}
                <button className={styles.button} onClick={copyReference}>Copy T3 reference</button><code className={styles.reference}>{threadReference(thread.threadId)}</code><p role="status" className={styles.help}>{copyStatus}</p><h4>Activity timeline</h4>{!detail || detail.status !== "ready" ? <ReadNotice state={detail ?? { status: "unavailable" }} empty="Thread activity unavailable" preview={preview} /> : <><ol className={styles.timeline}>{detail.data.items.map((item) => <ActivityEntry key={item.id} item={item} live={live} />)}</ol>{detail.data.items.length === 0 && <p>No activity returned.</p>}<h4>Recent runs</h4>{detail.data.recentRuns.length === 0 ? <p className={styles.help}>No recent runs returned.</p> : <ul className={styles.models}>{detail.data.recentRuns.map((run) => <li key={run.runId}><strong>{run.status ?? "Run status unknown"} · {run.model ?? "Model unknown"}</strong><code>{run.runId}</code><small>{run.completedAt ?? run.startedAt ?? run.requestedAt ?? "Run time unknown"}</small></li>)}</ul>}{detail.data.hasMore && (live ? <LiveAction onClick={() => void live.actions.loadMoreActivity()} busy={live.paging.activity}>Load more activity</LiveAction> : <UnavailableAction>Load more activity</UnavailableAction>)}<FreshnessNote freshness={detail.data.freshness} /></>}</> : <p>{live ? "Select a thread to read its activity." : "No matching threads. Clear the search or change the project."}</p>}</div></div><FreshnessNote freshness={data.threads.data.freshness} />{data.threads.data.nextCursor !== null && (live ? <LiveAction onClick={() => void live.actions.loadMoreThreads()} busy={live.paging.threads}>Load more threads</LiveAction> : <UnavailableAction>Load more threads</UnavailableAction>)}
                {/* Native write controls (EGA-764 / EGA-765). Bound to the EXACT selected
                    identity so a selection change remounts them and can never deliver text or
                    an interrupt to the previously selected thread. A fixture preview never
                    mounts them, so sample data cannot reach the network. */}
                {live && !preview && thread && canOperateSelected ? (
                  <div className={styles.followUp}>
                    <FollowUpControl
                      key={`follow-up:${thread.connectionId}:${thread.projectId}:${thread.threadId}`}
                      connectionId={thread.connectionId}
                      projectId={thread.projectId}
                      threadId={thread.threadId}
                      threadTitle={thread.title}
                    
                      onAccepted={() => live.actions.reloadActivity()}
                    />
                    {activeRunId ? (
                      <InterruptControl
                        key={`interrupt:${thread.connectionId}:${thread.projectId}:${thread.threadId}:${activeRunId}`}
                        connectionId={thread.connectionId}
                        projectId={thread.projectId}
                        threadId={thread.threadId}
                        runId={activeRunId}
                        runStatus={activeRunStatus}
                      
                        onDone={(result) => { if (result.outcome === "requested") live.actions.reloadActivity(); }}
                      />
                    ) : (
                      // No observed run means there is nothing to interrupt. Say so
                      // rather than offering a button that cannot be bound to a run.
                      <p className={styles.help}>
                        {liveRunAmbiguous
                          ? "More than one run looks live for this thread. Helm will not guess which to interrupt — choose the run in T3."
                          : "No live run to interrupt for this thread. Load its activity first."}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className={styles.followUp}>
                    <p className={styles.help}>{preview ? "Sample data: native controls are not available in a fixture preview." : !thread ? "Select a thread to use native follow-up and interrupt." : !canOperateSelected ? "This connection is read-only. Reconnect with operate access to send follow-ups or interrupt runs." : "Connect T3 to use native follow-up and interrupt."}</p>
                  </div>
                )}
            </>}
          </section>
          <footer className={styles.footer}><p>Owner access verified by Convex.</p><span>Helm / Private workspace</span>{serviceStatus}</footer>
        </div>
      </div>
    </div>
  );
}

export function NativeT3Dashboard({ accountControls, serviceStatus }: { accountControls: ReactNode; serviceStatus: ReactNode }) {
  const [fixtureModule, setFixtureModule] = useState<typeof import("./fixtures") | null>(null);
  const [scenario, setScenario] = useState<FixtureScenario | "off">("off");
  const [fixtureError, setFixtureError] = useState(false);
  const allowed = fixturesEnabled();
  const previewing = allowed && scenario !== "off";
  // A fixture preview must never reach the network, so it disables every read.
  const controller = useT3Dashboard({ enabled: !previewing });
  useEffect(() => {
    if (!fixturesEnabled()) return;
    let active = true;
    import("./fixtures").then((module) => { if (active) setFixtureModule(module); }).catch(() => { if (active) setFixtureError(true); });
    return () => { active = false; };
  }, []);

  /**
   * The backend callback redirects back here with a coarse `t3` status. It is
   * read from the address bar after mount rather than with `useSearchParams`,
   * which would force a Suspense boundary around the whole dashboard, and the
   * query is cleared so no OAuth detail survives in history or a shared link.
   */
  const applyCallback = useRef(controller.actions.applyCallbackStatus);
  useEffect(() => { applyCallback.current = controller.actions.applyCallbackStatus; }, [controller.actions]);
  const callbackApplied = useRef(false);
  useEffect(() => {
    if (callbackApplied.current) return;
    const status = new URLSearchParams(window.location.search).get("t3");
    if (!status) return;
    callbackApplied.current = true;
    applyCallback.current(status);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  const fixture = allowed && fixtureModule && scenario !== "off" ? fixtureModule.getFixture(scenario) : null;
  const controls = allowed ? <div className={styles.fixtureControls}><label htmlFor="fixture-scenario">Development fixture preview</label><select id="fixture-scenario" value={scenario} disabled={!fixtureModule} onChange={(event) => setScenario(event.target.value as FixtureScenario | "off")}><option value="off">Off — read the live T3 backend</option>{fixtureModule?.fixtureScenarios.map((name) => <option key={name} value={name}>{name.replaceAll("-", " ")}</option>)}</select><p className={styles.help}>{fixtureError ? "Fixture preview failed to load." : "Local sample data only. No T3 or OAuth requests. Select a scenario to preview."}</p></div> : undefined;
  return <DashboardView
    key={fixture ? scenario : "off"}
    data={fixture ?? controller.data}
    controller={fixture ? undefined : controller}
    preview={fixture !== null}
    previewControls={controls}
    accountControls={accountControls}
    serviceStatus={serviceStatus}
  />;
}
