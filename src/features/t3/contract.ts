/** UI projection, not an MCP wire contract. Backend owns decoding and authorization. */
export type Metadata = Readonly<Record<string, unknown>> | null;
export type AccessLevel = "read-only" | "supervised" | "full-access";
export type ConnectionStatus = "connected" | "disconnected" | "expired" | "revoked";
export interface ConnectionRecord {
  connectionId: string;
  displayName: string | null;
  endpoint: string;
  environmentId: string | null;
  access: AccessLevel | null;
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
}
export interface ConnectedEnvironment {
  connection: ConnectionRecord;
  /** Null means the backend has not confirmed this server's T3 identity yet. */
  environment: Environment | null;
}
export type ConnectionState =
  | { status: "not-connected" }
  | { status: "pending"; expiresAt: string | null }
  | { status: "denied" }
  | { status: "expired"; expiredAt: string | null }
  | { status: "failed"; error: UiError }
  | { status: "connected"; connection: ConnectionRecord };

export type ErrorCode = "backend_unavailable" | "invalid_endpoint" | "access_denied" | "consent_denied" | "consent_expired" | "connection_expired" | "revoked" | "unreachable" | "provider_unavailable" | "not_found" | "rate_limited" | "cursor_invalid" | "unknown";
export interface UiError {
  code: ErrorCode;
  /** Sanitized user-facing text only; never raw MCP/OAuth errors or credentials. */
  message: string;
  retryable: boolean;
  requestId?: string | null;
  retryAfterMs?: number | null;
}
export interface Freshness {
  source: "backend" | "fixture" | "unavailable";
  observedAt: string | null;
  stale: boolean;
  /** Optional backend snapshot identity; upstream pages are not stable snapshots. */
  snapshotId?: string | null;
}
export interface Page<T> {
  items: readonly T[];
  nextCursor: number | null;
  total?: number | null;
  freshness: Freshness;
}
export type ReadState<T> =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; data: T };
export type AsyncResponse<T> =
  | { status: "completed"; data: T; freshness: Freshness }
  | { status: "accepted"; operationId: string; pollAfterMs: number | null }
  | { status: "failed"; error: UiError };

export interface Environment {
  environmentId: string;
  label: string | null;
  serverVersion?: string | null;
  platform?: string | null;
  metadata?: Metadata;
}
export interface OAuthStartResult {
  /** Opaque backend correlation ID; never a token or authorization code. */
  attemptId: string;
  /** Validated, short-lived T3 consent URL returned by the backend. */
  authorizationUrl: string;
  expiresAt: string | null;
}
export interface Project {
  connectionId: string;
  projectId: string;
  environmentId: string;
  title: string | null;
  status: string | null;
  workspaceRoot?: string | null;
  repositoryIdentity?: string | null;
  defaultModel?: string | null;
  metadata?: Metadata;
}
export interface Model {
  id: string;
  label: string | null;
  /** Keep unrecognized option descriptors opaque; do not invent supported options. */
  options?: readonly unknown[] | null;
}
export interface Provider {
  providerInstanceId: string;
  driverKind?: string | null;
  displayName: string | null;
  models: readonly Model[] | null;
  runtimeModes?: readonly string[] | null;
  canRunChildTask?: boolean | null;
  canRunCrossProviderChildTask?: boolean | null;
  authenticationStatus?: "authenticated" | "unauthenticated" | "unknown" | null;
  constraints?: readonly string[] | null;
  /** Availability is separate from model identity; null means unknown. */
  availability?: "available" | "unavailable" | null;
}
export interface Catalog {
  providers: readonly Provider[];
  features: OrchestrationFeatures | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  parentThreadId?: string | null;
  inheritedProviderInstanceId?: string | null;
  inheritedModel?: string | null;
  freshness: Freshness;
}
/** Structured projection of orchestrator_capabilities.features. */
export interface OrchestrationFeatures {
  appOwnedSubagents: boolean | null;
  asyncPolling: boolean | null;
  cancellation: boolean | null;
  batchThreadCreation: boolean | null;
  threadManagement: boolean | null;
  incrementalThreadRead: boolean | null;
  scheduledTasks: boolean | null;
  maxBatchThreads: number | null;
}
export interface Thread {
  connectionId: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  title: string | null;
  status: string | null;
  providerInstanceId?: string | null;
  model?: string | null;
  runtimeMode?: string | null;
  interactionMode?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  latestRunId?: string | null;
  parentThreadId?: string | null;
  linkedPullRequest?: Metadata;
  updatedAt: string | null;
  metadata?: Metadata;
}
export interface Activity {
  id: string;
  position: number;
  kind: string | null;
  text: string | null;
  createdAt: string | null;
  truncated: boolean;
  nextTextOffset?: number | null;
  metadata?: Metadata;
}
export interface ThreadDetail {
  thread: Thread;
  items: readonly Activity[];
  recentRuns: readonly ThreadRun[];
  nextPosition: number | null;
  hasMore: boolean;
  freshness: Freshness;
}
/** Stable UI key for detail maps because thread IDs can repeat across connections. */
export const threadDetailKey = (connectionId: string, threadId: string) => JSON.stringify([connectionId, threadId]);
export interface ThreadRun {
  runId: string;
  ordinal: number | null;
  status: string | null;
  providerInstanceId: string | null;
  model: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
export interface ConnectionInput { endpoint: string; clientRequestId: string }
export interface ConnectionReadInput { connectionId: string }
export interface ConnectionOperationInput extends ConnectionReadInput { clientRequestId: string }
export interface PageInput { cursor?: number; limit?: number }
export interface ListInput extends PageInput { connectionId: string }
export interface ProjectReadInput { connectionId: string; projectId: string }
export interface ThreadListInput extends ListInput { projectId: string; titleContains?: string; statuses?: readonly string[] }
export interface ThreadReadInput { connectionId: string; threadId: string; view?: "messages" | "activity"; afterPosition?: number; limit?: number; itemId?: string; textOffset?: number }
export interface FollowUpInput { connectionId: string; threadId: string; message: string; mode?: "auto" | "queue" | "steer" | "restart"; clientRequestId: string }
export interface InterruptInput { connectionId: string; threadId: string; runId?: string | null; clientRequestId: string }
export interface ThreadStartInput { connectionId: string; projectId: string; prompt: string; providerInstanceId?: string; model?: string; runtimeMode?: string; interactionMode?: string }
export interface ThreadOperationResult { threadId: string; runId: string | null; status: string | null }
export interface DisconnectResult { connectionId: string; status: "disconnected" }
/** Future owner-authorized adapter interface only. No implementation or routes exist. */
export interface T3BackendInterface {
  readConnection(): Promise<AsyncResponse<ConnectionState>>;
  readEnvironments(input: PageInput): Promise<AsyncResponse<Page<ConnectedEnvironment>>>;
  readEnvironment(input: ConnectionReadInput): Promise<AsyncResponse<Environment>>;
  listProjects(input: ListInput): Promise<AsyncResponse<Page<Project>>>;
  readProject(input: ProjectReadInput): Promise<AsyncResponse<Project>>;
  readCatalog(input: ConnectionReadInput): Promise<AsyncResponse<Catalog>>;
  listThreads(input: ThreadListInput): Promise<AsyncResponse<Page<Thread>>>;
  readThread(input: ThreadReadInput): Promise<AsyncResponse<ThreadDetail>>;
  connect(input: ConnectionInput): Promise<AsyncResponse<OAuthStartResult>>;
  reconnect(input: ConnectionOperationInput): Promise<AsyncResponse<OAuthStartResult>>;
  disconnect(input: ConnectionOperationInput): Promise<AsyncResponse<DisconnectResult>>;
  startThread(input: ThreadStartInput): Promise<AsyncResponse<ThreadOperationResult>>;
  followUp(input: FollowUpInput): Promise<AsyncResponse<ThreadOperationResult>>;
  interrupt(input: InterruptInput): Promise<AsyncResponse<ThreadOperationResult>>;
  readOperation(input: { operationId: string }): Promise<AsyncResponse<unknown>>;
}
export interface DashboardData {
  connection: ConnectionState;
  /** Connection inventory enriched with identity reads for each T3 server. */
  environments: ReadState<Page<ConnectedEnvironment>>;
  projects: ReadState<Page<Project>>;
  catalog: ReadState<Catalog>;
  threads: ReadState<Page<Thread>>;
  /** Keyed by threadDetailKey(connectionId, threadId), never by thread ID alone. */
  details: Readonly<Record<string, ReadState<ThreadDetail>>>;
}
export const unavailableDashboard: DashboardData = {
  connection: { status: "not-connected" },
  environments: { status: "unavailable" }, projects: { status: "unavailable" },
  catalog: { status: "unavailable" }, threads: { status: "unavailable" }, details: {},
};
