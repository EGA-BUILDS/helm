import { threadDetailKey, type ConnectedEnvironment, type DashboardData, type Freshness, type Page, type Project, type Thread, type ThreadDetail } from "./contract";
import { unavailableDashboard } from "./contract";
import { fixturesEnabled } from "./fixture-gate";

export const fixtureScenarios = ["not-connected", "pending", "denied", "expired", "failed", "connected", "missing-environments", "empty-projects", "empty-threads", "provider-unavailable", "loading", "read-error", "stale"] as const;
export type FixtureScenario = typeof fixtureScenarios[number];
const freshness: Freshness = { source: "fixture", observedAt: null, stale: false };
const page = <T>(items: readonly T[]): Page<T> => ({ items, nextCursor: null, total: items.length, freshness });
const environments: readonly ConnectedEnvironment[] = [
  {
    connection: { connectionId: "sample-connection-studio", displayName: "Studio", endpoint: "https://studio.example.invalid/mcp", environmentId: "sample-studio", access: "read-only", status: "connected", lastVerifiedAt: null, lastReadAt: null, errorCode: null, expiresAt: null },
    environment: { environmentId: "sample-studio", label: "Studio", platform: "linux", serverVersion: null },
  },
  {
    connection: { connectionId: "sample-connection-laptop", displayName: "Laptop", endpoint: "https://laptop.example.invalid/mcp", environmentId: "sample-laptop", access: "supervised", status: "expired", lastVerifiedAt: null, lastReadAt: null, errorCode: null, expiresAt: null },
    environment: { environmentId: "sample-laptop", label: "Laptop", platform: null, serverVersion: null },
  },
  {
    connection: { connectionId: "sample-connection-studio-old", displayName: "Studio backup", endpoint: "https://backup.example.invalid/mcp", environmentId: null, access: null, status: "disconnected", lastVerifiedAt: null, lastReadAt: null, errorCode: null, expiresAt: null },
    environment: null,
  },
];
const projects: readonly Project[] = [
  { connectionId: "sample-connection-studio", projectId: "sample-helm", environmentId: "sample-studio", title: "Helm", status: null, workspaceRoot: "/sample/helm", repositoryIdentity: null, defaultModel: null },
  { connectionId: "sample-connection-studio", projectId: "sample-design", environmentId: "sample-studio", title: "Design system", status: null, workspaceRoot: "/sample/design-system", repositoryIdentity: null },
  { connectionId: "sample-connection-laptop", projectId: "sample-notes", environmentId: "sample-laptop", title: "Field notes", status: null, workspaceRoot: null, repositoryIdentity: null },
];
const threads: readonly Thread[] = [
  { connectionId: "sample-connection-studio", threadId: "sample-thread-navigation", projectId: "sample-helm", environmentId: "sample-studio", title: "Refine the workspace navigation", status: "completed", providerInstanceId: "sample-provider", model: "sample-model", runtimeMode: "approval-required", interactionMode: "default", branch: "sample/navigation", worktreePath: null, updatedAt: null },
  { connectionId: "sample-connection-studio", threadId: "sample-thread-contract", projectId: "sample-helm", environmentId: "sample-studio", title: "Review the frontend contract", status: "waiting", model: null, updatedAt: null },
  { connectionId: "sample-connection-studio", threadId: "sample-thread-type", projectId: "sample-design", environmentId: "sample-studio", title: "Explore typography tokens", status: "idle", model: null, updatedAt: null },
  { connectionId: "sample-connection-laptop", threadId: "sample-thread-notes", projectId: "sample-notes", environmentId: "sample-laptop", title: "Organize field notes", status: "running", model: null, updatedAt: null },
];
const details: Record<string, { status: "ready"; data: ThreadDetail }> = Object.fromEntries(threads.map((thread) => [threadDetailKey(thread.connectionId, thread.projectId, thread.threadId), { status: "ready", data: {
  thread, freshness, nextPosition: null, hasMore: false, recentRuns: thread.threadId === "sample-thread-navigation" ? [{ runId: "sample-run-navigation", ordinal: 1, status: "completed", providerInstanceId: "sample-provider", model: "sample-model", requestedAt: null, startedAt: null, completedAt: null }] : [],
  items: [
    { id: `${thread.threadId}-1`, position: 0, kind: "user", text: "Sample request: review the workspace layout and document the next steps.", createdAt: null, truncated: false },
    { id: `${thread.threadId}-2`, position: 1, kind: "activity", text: "Sample activity: inspected frontend components in a local workspace.", createdAt: null, truncated: false },
    { id: `${thread.threadId}-3`, position: 2, kind: "assistant", text: "Sample response: the layout review is ready. No real agent has run.", createdAt: null, truncated: false },
  ],
} }]));
/** Second gate: even direct fixture imports cannot enable preview in production. */
export function getFixture(scenario: FixtureScenario): DashboardData | null {
  if (!fixturesEnabled()) return null;
  if (["not-connected", "pending", "denied", "expired", "failed"].includes(scenario)) {
    const connection: DashboardData["connection"] = scenario === "pending" ? { status: "pending", expiresAt: null }
      : scenario === "denied" ? { status: "denied" }
      : scenario === "expired" ? { status: "expired", expiredAt: null }
      : scenario === "failed" ? { status: "failed", error: { code: "unreachable", message: "Sample endpoint could not be reached.", retryable: true } }
      : { status: "not-connected" };
    return { ...unavailableDashboard, connection };
  }
  const data: DashboardData = {
    connection: { status: "connected", connection: environments[0].connection },
    environments: { status: "ready", data: page(environments) },
    projects: { status: "ready", data: page(projects) },
    threads: { status: "ready", data: page(threads) }, details,
    projectDetail: { status: "unavailable" },
    catalog: { status: "ready", data: { providers: [{ providerInstanceId: "sample-provider", displayName: "Example provider", driverKind: null, availability: null, authenticationStatus: null, canRunChildTask: null, canRunCrossProviderChildTask: null, models: [{ id: "sample-model", label: "Example model", options: null }], runtimeModes: null, constraints: [] }], features: { appOwnedSubagents: null, asyncPolling: null, cancellation: null, batchThreadCreation: null, threadManagement: null, incrementalThreadRead: null, scheduledTasks: null, maxBatchThreads: null }, runtimeMode: "approval-required", interactionMode: "default", freshness } },
  };
  if (scenario === "missing-environments") return { ...data, environments: { status: "ready", data: page([]) }, projects: { status: "ready", data: page([]) }, threads: { status: "ready", data: page([]) }, details: {}, catalog: { status: "unavailable" } };
  if (scenario === "empty-projects") return { ...data, projects: { status: "ready", data: page([]) }, threads: { status: "ready", data: page([]) }, details: {} };
  if (scenario === "empty-threads") return { ...data, threads: { status: "ready", data: page([]) }, details: {} };
  if (scenario === "provider-unavailable") return { ...data, catalog: { status: "error", error: { code: "provider_unavailable", message: "Provider catalog is unavailable in this sample.", retryable: true } } };
  if (scenario === "loading") return { ...data, projects: { status: "loading" }, threads: { status: "loading" }, catalog: { status: "loading" }, details: {} };
  if (scenario === "read-error") return { ...data, projects: { status: "error", error: { code: "unknown", message: "Sample project read failed. No data is available.", retryable: true } } };
  if (scenario === "stale") return { ...data, projects: { status: "ready", data: { ...page(projects), freshness: { ...freshness, stale: true } } } };
  return data;
}
