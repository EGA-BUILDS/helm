"use client";

import { useEffect, useState, type ReactNode } from "react";
import { threadDetailKey, type DashboardData, type Freshness, type ReadState } from "./contract";
import { unavailableDashboard } from "./contract";
import { fixturesEnabled } from "./fixture-gate";
import type { FixtureScenario } from "./fixtures";
import { accessLevels, backendUnavailable, connectionCopy, filterProjects, filterThreads, threadReference, validateEndpoint } from "./ui";
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

function UnavailableAction({ children }: { children: ReactNode }) {
  return <button className={styles.button} disabled aria-describedby="t3-backend-unavailable">{children}</button>;
}
function ReadNotice({ state, empty }: { state: ReadState<unknown>; empty: string }) {
  if (state.status === "loading") {
    const label = `Loading ${empty.replace(/ unavailable$/, "").toLowerCase()}…`;
    return <div className={styles.loading} role="status"><span className={styles.srOnly}>{label}</span><span className={styles.skeleton} aria-hidden="true"><i /><i /><i /></span></div>;
  }
  if (state.status === "error") return <p className={styles.empty} role="alert">{state.error.message}</p>;
  return <p className={styles.empty}>{empty}. {backendUnavailable}</p>;
}
function FreshnessNote({ freshness }: { freshness: Freshness }) {
  const source = freshness.source === "fixture" ? "Sample data" : freshness.source === "backend" ? "Backend snapshot" : "Source unavailable";
  return <p className={styles.freshness}>{source} · {freshness.stale ? "Stale — refresh required" : freshness.observedAt ? `Observed ${freshness.observedAt}` : "Freshness unknown"}</p>;
}
function MetadataRow({ label, value }: { label: string; value?: string | null }) {
  return <div><dt>{label}</dt><dd>{value ?? "Unknown"}</dd></div>;
}
function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2></div>{children}</div>;
}

/** Pure frontend view; the only application caller supplies unavailable or gated fixture data. */
export function DashboardView({ data, preview = false, accountControls, previewControls, serviceStatus }: {
  data: DashboardData; preview?: boolean; accountControls?: ReactNode; previewControls?: ReactNode; serviceStatus?: ReactNode;
}) {
  const [activeSection, setActiveSection] = useState("overview");
  const [endpoint, setEndpoint] = useState("");
  const [touched, setTouched] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [threadSearch, setThreadSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
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
  const thread = visibleThreads.find((item) => item.threadId === selectedThreadId) ?? visibleThreads[0];
  const detail = thread ? data.details[threadDetailKey(thread.connectionId, thread.threadId)] : undefined;
  const catalog = data.catalog.status === "ready" ? data.catalog.data : null;
  const connected = data.connection.status === "connected";
  const approvedAccess = data.connection.status === "connected" ? data.connection.connection.access : null;

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
            <div className={styles.notice} id="t3-backend-unavailable"><span aria-hidden="true">○</span><div><strong>{preview ? "Development fixture preview — no live T3 connection" : connected ? "T3 authorization verified by the backend" : "T3 backend integration is not available yet"}</strong><p>{preview || !connected ? `${backendUnavailable} Local browsing and URL validation are available.` : "T3 remains the source of truth for project, catalog, and thread data."}</p></div></div>
            {previewControls}
            <div className={styles.metrics}>
              <div><span>T3 connection</span><strong className={styles.metricText}>{connected ? preview ? "Sample connected" : "Connected" : "Not connected"}</strong><small>{preview ? "Simulated state only" : connected ? "Verified by backend" : "No authorization started"}</small></div>
              <div><span>Environments</span><strong>{data.environments.status === "ready" ? environments.length : "—"}</strong><small>{preview ? "In this sample" : "Awaiting backend"}</small></div>
              <div><span>Projects</span><strong>{data.projects.status === "ready" ? projects.length : "—"}</strong><small>{preview ? "In the loaded sample page" : "Awaiting backend"}</small></div>
              <div><span>Threads</span><strong>{data.threads.status === "ready" ? threads.length : "—"}</strong><small>{preview ? "In the loaded sample page" : "Awaiting backend"}</small></div>
            </div>
          </section>

          <section id="connect" className={styles.section} aria-label="Connect T3">
            <SectionTitle eyebrow="01 / CONNECTION" title="Connect your workspace"><span className={styles.badge}>{preview ? `Sample: ${data.connection.status}` : data.connection.status === "connected" ? "Connected" : data.connection.status === "pending" ? "Authorization pending" : data.connection.status === "failed" ? "Connection failed" : data.connection.status === "expired" ? "Expired" : data.connection.status === "denied" ? "Consent denied" : "Not connected"}</span></SectionTitle>
            <div className={styles.connectionGrid}>
              <div className={styles.panel}>
                <div className={styles.connectionIcon} aria-hidden="true">↗</div><h3>{copy.title}</h3><p>{copy.description}</p>
                {data.connection.status === "failed" && <p role="alert" className={styles.error}>{data.connection.error.message}</p>}
                {data.connection.status === "pending" && <p role="status">Sample approval request pending. {data.connection.expiresAt ? `Request expires ${data.connection.expiresAt}.` : "Request expiry unknown."}</p>}
                {connected && data.connection.status === "connected" ? <>
                  <dl className={styles.metadata}><MetadataRow label="Connection name" value={data.connection.connection.displayName} /><MetadataRow label="Environment identity" value={data.connection.connection.environmentId} /><MetadataRow label="MCP endpoint" value={data.connection.connection.endpoint} /><MetadataRow label="Approved access" value={accessLevels.find((level) => level.id === approvedAccess)?.title} /><MetadataRow label="Last verified" value={data.connection.connection.lastVerifiedAt} /><MetadataRow label="Approval expires" value={data.connection.connection.expiresAt} /></dl>
                  <div className={styles.actions}><UnavailableAction>Reconnect</UnavailableAction><UnavailableAction>Disconnect</UnavailableAction></div>
                </> : <form onSubmit={(event) => event.preventDefault()} noValidate>
                  <label htmlFor="t3-endpoint">T3 MCP endpoint</label><input id="t3-endpoint" type="url" placeholder="https://your-environment/mcp" value={endpoint} autoComplete="off" spellCheck={false} aria-describedby="t3-endpoint-help t3-endpoint-validation" aria-invalid={touched && !validation.valid} onChange={(event) => { setEndpoint(event.target.value); setTouched(true); }} onBlur={() => setTouched(true)} />
                  <p id="t3-endpoint-help" className={styles.help}>Copy the native /mcp URL from T3 Settings → Connections. Helm’s future backend must be able to reach it.</p>
                  <p id="t3-endpoint-validation" className={touched && !validation.valid ? styles.error : styles.help} aria-live="polite">{touched ? validation.valid ? "URL format looks valid. Reachability has not been checked." : validation.message : "URL validation is local. This form never sends a request."}</p>
                  <UnavailableAction>{data.connection.status === "not-connected" ? "Connect T3" : "Reconnect"}</UnavailableAction>
                </form>}
              </div>
              <div className={styles.explainer}><p className={styles.eyebrow}>YOU CHOOSE THE ACCESS</p><h3>Approval lives at T3.</h3><p>Helm sign-in and T3 consent are separate. You choose the permission level on T3’s sign-in page.</p><ol className={styles.steps}><li><span>1</span>Copy your environment’s MCP URL.</li><li><span>2</span>Approve a sign-in you started at T3.</li><li><span>3</span>Review the environment and access scope.</li></ol><p className={styles.help}>An approved sign-in expires after 30 days. Revoke access anytime in T3 Settings → Connections.</p></div>
            </div>
            <div className={styles.accessGrid}>{accessLevels.map((level, index) => <article key={level.id}><span className={styles.accessNumber}>0{index + 1}</span><h3>{level.title}{index === 0 && <span className={styles.recommended}>Default</span>}</h3><p>{level.description}</p></article>)}</div>
          </section>

          <section id="environments" className={styles.section} aria-label="Environments">
            <SectionTitle eyebrow="02 / ENVIRONMENTS" title="Where your work runs" />
            {data.environments.status !== "ready" ? <ReadNotice state={data.environments} empty="Environments unavailable" /> : environments.length === 0 ? <p className={styles.empty}>No environments returned. A connection alone does not confirm environment identity.</p> : <><div className={styles.environmentGrid}>{environments.map(({ connection, environment }) => {
              const selected = selectedEnvironment?.connection.connectionId === connection.connectionId;
              const statusLabel = connection.status[0].toUpperCase() + connection.status.slice(1);
              return <article className={`${styles.environmentCard} ${selected ? styles.environmentSelected : ""}`} key={connection.connectionId}>
                <button className={styles.environmentSelect} aria-label={`Select ${connection.displayName ?? environment?.label ?? "unnamed"} environment`} aria-pressed={selected} onClick={() => { setSelectedConnectionId(connection.connectionId); setSelectedProjectId(null); setSelectedThreadId(null); setProjectFilter(""); setCopyStatus(""); }}>
                  <span className={styles.environmentIcon} aria-hidden="true">▣</span><span><strong>{connection.displayName ?? environment?.label ?? "Unnamed environment"}</strong><small>{connection.environmentId ?? environment?.environmentId ?? "Environment identity unknown"}</small></span>
                </button>
                <span className={`${styles.badge} ${styles[`status_${connection.status}`]}`}>{preview ? `Sample · ${statusLabel}` : statusLabel}</span>
                <dl className={styles.metadata}>
                  <MetadataRow label="Environment identity" value={connection.environmentId ?? environment?.environmentId} />
                  <MetadataRow label="MCP endpoint" value={connection.endpoint} />
                  <MetadataRow label="Permission" value={accessLevels.find((level) => level.id === connection.access)?.title} />
                  <MetadataRow label="Connection status" value={statusLabel} />
                  <MetadataRow label="Last verified" value={connection.lastVerifiedAt} />
                  <MetadataRow label="Approval expires" value={connection.expiresAt} />
                  <MetadataRow label="Platform" value={environment?.platform} />
                  <MetadataRow label="Server version" value={environment?.serverVersion} />
                </dl>
                <div className={styles.actions}><UnavailableAction>Reconnect</UnavailableAction><UnavailableAction>Disconnect</UnavailableAction></div>
              </article>;
            })}</div><FreshnessNote freshness={data.environments.data.freshness} /><p className={styles.help}>Selected environment: {selectedEnvironment?.connection.displayName ?? selectedEnvironment?.environment?.label ?? "Unknown"}. Project and thread lists are scoped to this environment.</p></>}
          </section>

          <section id="projects" className={styles.section} aria-label="Projects">
            <SectionTitle eyebrow="03 / PROJECTS" title="A home for every project" />
            <div className={styles.toolbar}><label htmlFor="project-search">Search projects</label><input id="project-search" type="search" placeholder="Search name, workspace, or ID…" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></div>
            {!activeConnectionId ? <p className={styles.empty}>Select a connected environment to browse its projects.</p> : data.projects.status !== "ready" ? <ReadNotice state={data.projects} empty="Projects unavailable" /> : projects.length === 0 ? <p className={styles.empty}>No projects returned for this environment.</p> : <>
              <p className={styles.help} role="status">{visibleProjects.length} matching projects in this loaded page.</p>
              <div className={styles.split}><ul className={styles.itemList} aria-label="Project list">{visibleProjects.map((item) => <li key={`${item.connectionId}:${item.projectId}`}><button aria-pressed={project?.projectId === item.projectId} onClick={() => setSelectedProjectId(item.projectId)}><span className={styles.listIcon} aria-hidden="true">▤</span><span><strong>{item.title ?? "Untitled project"}</strong><small>{item.workspaceRoot ?? "Workspace unknown"}</small></span><span aria-hidden="true">→</span></button></li>)}</ul><div className={styles.detail}>{project ? <><p className={styles.eyebrow}>PROJECT DETAILS{preview ? " · SAMPLE" : ""}</p><h3>{project.title ?? "Untitled project"}</h3><dl className={styles.metadata}><MetadataRow label="Project ID" value={project.projectId} /><MetadataRow label="Status" value={project.status} /><MetadataRow label="Environment" value={project.environmentId} /><MetadataRow label="Workspace" value={project.workspaceRoot} /><MetadataRow label="Repository" value={project.repositoryIdentity} /><MetadataRow label="Default model" value={project.defaultModel} /></dl><a href="#threads" onClick={() => { setProjectFilter(project.projectId); setActiveSection("threads"); setCopyStatus(""); }} className={styles.textLink}>Browse this project’s threads →</a></> : <p>No matching projects. Try a different search.</p>}</div></div>
              <FreshnessNote freshness={data.projects.data.freshness} /><p className={styles.help}>Search covers loaded pages only. Project pages may shift between snapshots.</p>{data.projects.data.nextCursor !== null && <UnavailableAction>Load more projects</UnavailableAction>}
            </>}
          </section>

          <section id="providers" className={styles.section} aria-label="Providers and models">
            <SectionTitle eyebrow="04 / PROVIDER CATALOG" title="Know what’s available" />
            {!catalog ? <ReadNotice state={data.catalog} empty="Provider catalog unavailable" /> : <><p className={styles.help}>Runtime mode: {catalog.runtimeMode ?? "Unknown"} · Interaction mode: {catalog.interactionMode ?? "Unknown"}. Advertised models do not prove availability.</p><div className={styles.providerGrid}>{catalog.providers.length === 0 && <p className={styles.empty}>No providers advertised.</p>}{catalog.providers.map((provider) => <article className={styles.panel} key={provider.providerInstanceId}><div className={styles.providerHeading}><h3>{provider.displayName ?? provider.providerInstanceId}</h3><span className={`${styles.badge} ${provider.availability === "unavailable" ? styles.status_expired : ""}`}>{provider.availability === "unavailable" ? "Unavailable" : provider.availability === "available" ? preview ? "Sample available" : "Available" : "Availability unknown"}</span></div><p className={styles.help}>{provider.providerInstanceId} · {provider.driverKind ?? "Driver unknown"}</p><dl className={styles.metadata}><MetadataRow label="Authentication" value={provider.authenticationStatus ?? "Unknown"} /><MetadataRow label="Child tasks" value={provider.canRunChildTask == null ? null : String(provider.canRunChildTask)} /><MetadataRow label="Cross-provider tasks" value={provider.canRunCrossProviderChildTask == null ? null : String(provider.canRunCrossProviderChildTask)} /></dl>{provider.models === null ? <p>Model catalog unknown.</p> : provider.models.length === 0 ? <p>No models advertised.</p> : <ul className={styles.models}>{provider.models.map((model) => <li key={model.id}><strong>{model.label ?? model.id}</strong><code>{model.id}</code><small>{model.options == null ? "Options unknown" : `${model.options.length} advertised option descriptors`}</small></li>)}</ul>}<p className={styles.help}>Runtime modes: {provider.runtimeModes?.join(", ") ?? "Not specified"}</p>{provider.constraints?.map((constraint) => <p key={constraint} className={styles.help}>{constraint}</p>)}</article>)}</div><details className={styles.features}><summary>Orchestration features</summary>{catalog.features ? <dl className={styles.metadata}>{Object.entries(catalog.features).map(([name, value]) => <MetadataRow key={name} label={featureLabels.find(([key]) => key === name)?.[1] ?? name} value={value == null ? null : String(value)} />)}</dl> : <p>Features unknown. No support is assumed.</p>}</details><FreshnessNote freshness={catalog.freshness} /></>}
          </section>

          <section id="threads" className={styles.section} aria-label="Threads">
            <SectionTitle eyebrow="05 / THREAD ACTIVITY" title="Follow the work"><UnavailableAction>Start thread</UnavailableAction></SectionTitle>
            <div className={styles.toolbar}><div><label htmlFor="thread-search">Search threads</label><input id="thread-search" type="search" placeholder="Search title, status, or model…" value={threadSearch} onChange={(event) => { setThreadSearch(event.target.value); setCopyStatus(""); }} /></div><div><label htmlFor="thread-project">Project</label><select id="thread-project" value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setCopyStatus(""); }}><option value="">All loaded projects</option>{projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.title ?? item.projectId}</option>)}</select></div></div>
            {!activeConnectionId ? <p className={styles.empty}>Select a connected environment to browse its threads.</p> : data.threads.status !== "ready" ? <ReadNotice state={data.threads} empty="Threads unavailable" /> : threads.length === 0 ? <p className={styles.empty}>No threads returned. Start a thread in T3; thread launch from Helm is unavailable.</p> : <>
              <p role="status" className={styles.help}>{visibleThreads.length} matching threads in this loaded page.</p><div className={styles.split}><ul className={styles.itemList} aria-label="Thread list">{visibleThreads.map((item) => <li key={item.threadId}><button aria-pressed={thread?.threadId === item.threadId} onClick={() => { setSelectedThreadId(item.threadId); setCopyStatus(""); }}><span className={styles.listIcon} aria-hidden="true">≋</span><span><strong>{item.title ?? "Untitled thread"}</strong><small>{item.status ?? "Status unknown"} · {item.projectId} · {item.updatedAt ?? "Activity time unknown"}</small></span></button></li>)}</ul><div className={styles.detail}>{thread ? <><p className={styles.eyebrow}>THREAD DETAILS{preview ? " · SAMPLE" : ""}</p><h3>{thread.title ?? "Untitled thread"}</h3><dl className={styles.metadata}><MetadataRow label="Thread ID" value={thread.threadId} /><MetadataRow label="Status" value={thread.status} /><MetadataRow label="Last activity" value={thread.updatedAt} /><MetadataRow label="Provider" value={thread.providerInstanceId} /><MetadataRow label="Model" value={thread.model} /><MetadataRow label="Runtime mode" value={thread.runtimeMode} /><MetadataRow label="Interaction mode" value={thread.interactionMode} /><MetadataRow label="Branch" value={thread.branch} /><MetadataRow label="Worktree" value={thread.worktreePath} /></dl><button className={styles.button} onClick={copyReference}>Copy T3 reference</button><code className={styles.reference}>{threadReference(thread.threadId)}</code><p role="status" className={styles.help}>{copyStatus}</p><h4>Activity timeline</h4>{!detail || detail.status !== "ready" ? <ReadNotice state={detail ?? { status: "unavailable" }} empty="Thread activity unavailable" /> : <><ol className={styles.timeline}>{detail.data.items.map((item) => <li key={item.id}><span>{item.kind ?? "Unknown activity"} · {item.createdAt ?? "Time unknown"}</span><p>{item.text ?? "Content unavailable"}</p>{item.truncated && <p className={styles.help}>Truncated content. Further text is unavailable until backend integration.</p>}</li>)}</ol>{detail.data.items.length === 0 && <p>No activity returned.</p>}<h4>Recent runs</h4>{detail.data.recentRuns.length === 0 ? <p className={styles.help}>No recent runs returned.</p> : <ul className={styles.models}>{detail.data.recentRuns.map((run) => <li key={run.runId}><strong>{run.status ?? "Run status unknown"} · {run.model ?? "Model unknown"}</strong><code>{run.runId}</code><small>{run.completedAt ?? run.startedAt ?? run.requestedAt ?? "Run time unknown"}</small></li>)}</ul>}{detail.data.hasMore && <UnavailableAction>Load more activity</UnavailableAction>}<FreshnessNote freshness={detail.data.freshness} /></>}<div className={styles.followUp}><label htmlFor="thread-follow-up">Follow-up message</label><textarea id="thread-follow-up" disabled placeholder="Messaging will be available after backend integration" aria-describedby="t3-backend-unavailable" /><div className={styles.actions}><UnavailableAction>Send follow-up</UnavailableAction><UnavailableAction>Interrupt thread</UnavailableAction></div></div></> : <p>No matching threads. Clear the search or change the project.</p>}</div></div><FreshnessNote freshness={data.threads.data.freshness} />{data.threads.data.nextCursor !== null && <UnavailableAction>Load more threads</UnavailableAction>}
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
  useEffect(() => {
    if (!fixturesEnabled()) return;
    let active = true;
    import("./fixtures").then((module) => { if (active) setFixtureModule(module); }).catch(() => { if (active) setFixtureError(true); });
    return () => { active = false; };
  }, []);
  const fixture = allowed && fixtureModule && scenario !== "off" ? fixtureModule.getFixture(scenario) : null;
  const controls = allowed ? <div className={styles.fixtureControls}><label htmlFor="fixture-scenario">Development fixture preview</label><select id="fixture-scenario" value={scenario} disabled={!fixtureModule} onChange={(event) => setScenario(event.target.value as FixtureScenario | "off")}><option value="off">Off — backend unavailable</option>{fixtureModule?.fixtureScenarios.map((name) => <option value={name} key={name}>{name.replaceAll("-", " ")}</option>)}</select><p className={styles.help}>{fixtureError ? "Fixture preview failed to load." : "Local sample data only. No T3 or OAuth requests. Select a scenario to preview."}</p></div> : undefined;
  return <DashboardView key={fixture ? scenario : "off"} data={fixture ?? unavailableDashboard} preview={fixture !== null} previewControls={controls} accountControls={accountControls} serviceStatus={serviceStatus} />;
}
