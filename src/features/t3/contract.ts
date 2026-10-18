/** UI projection, not an MCP wire contract. Backend owns decoding and authorization. */
export type Metadata = Readonly<Record<string, unknown>> | null;
export type AccessLevel = "read-only" | "supervised" | "full-access";
/**
 * Mirrors the status vocabulary the backend actually projects. `revoked` is the
 * backend's projection of `reauthorizationRequired`; `unreachable` is a saved
 * connection the backend has not been able to verify.
 */
export type ConnectionStatus = "connected" | "disconnected" | "expired" | "revoked" | "unreachable";
/** Connection-level failure the backend recorded on its last verification. */
export type ConnectionErrorCode =
  | "authorization_required"
  | "authorization_expired"
  | "endpoint_identity_changed"
  | "rate_limited"
  | "read_failed"
  | "unreachable";
export interface ConnectionRecord {
  connectionId: string;
  displayName: string | null;
  endpoint: string;
  environmentId: string | null;
  access: AccessLevel | null;
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  /** Last successful T3 read, which is not the same claim as a fresh verification. */
  lastReadAt: string | null;
  errorCode: ConnectionErrorCode | null;
  expiresAt: string | null;
}
export interface ConnectedEnvironment {
  connection: ConnectionRecord;
  /** Null means the backend has not confirmed this server's T3 identity yet. */
  environment: Environment | null;
}
/**
 * Owner-visible authorization state. `revoked` and `unreachable` carry the saved
 * connection because the owner still has something to reconnect from; they are
 * never treated as connected.
 */
export type ConnectionState =
  | { status: "not-connected" }
  | { status: "pending"; expiresAt: string | null }
  | { status: "denied" }
  | { status: "expired"; expiredAt: string | null; connection?: ConnectionRecord }
  | { status: "revoked"; connection: ConnectionRecord }
  | { status: "unreachable"; connection: ConnectionRecord }
  | { status: "failed"; error: UiError }
  | { status: "connected"; connection: ConnectionRecord };

export type ErrorCode =
  | "backend_unavailable"
  | "invalid_endpoint"
  | "access_denied"
  | "consent_denied"
  | "consent_expired"
  | "connection_expired"
  | "revoked"
  | "unreachable"
  | "provider_unavailable"
  | "not_found"
  | "rate_limited"
  | "read_failed"
  | "cursor_invalid"
  /** The T3 hostname did not resolve; may be a temporary DNS condition. */
  | "endpoint_unresolved"
  /** The endpoint's OAuth metadata did not match the requested resource/issuer. */
  | "discovery_mismatch"
  /** This deployment refused the mutation because its own origin is not configured. */
  | "origin_mismatch"
  /** A required OAuth deployment setting is absent, so no attempt can be made. */
  | "misconfigured"
  /** The backend answered 2xx with a body that does not match the known projection. */
  | "malformed_response"
  | "unknown";
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
  /** `0` is a valid upstream cursor and must never be read as "no more pages". */
  nextCursor: number | null;
  /** Upstream may legitimately omit the total; absence is unknown, not zero. */
  total: number | null;
  freshness: Freshness;
}
export type ReadState<T> =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; data: T };

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
/** Unambiguous identity for a thread across connections and projects. */
export const threadIdentity = (thread: { connectionId: string; projectId: string; threadId: string }) =>
  JSON.stringify([thread.connectionId, thread.projectId, thread.threadId]);
/** Stable key for a project scope (connection + project). */
export const projectScopeKey = (connectionId: string, projectId: string) => JSON.stringify([connectionId, projectId]);
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
export interface ConnectionInput { endpoint: string }
export interface ConnectionReadInput { connectionId: string }
export interface PageInput { cursor?: number; limit?: number }
export interface ListInput extends PageInput { connectionId: string }
export interface ProjectReadInput { connectionId: string; projectId: string }
export interface ThreadListInput extends ListInput { projectId: string; titleContains?: string; statuses?: readonly string[] }
export interface ThreadReadInput { connectionId: string; threadId: string; view?: "messages" | "activity"; afterPosition?: number; limit?: number; itemId?: string; textOffset?: number }
export interface DisconnectResult { connectionId: string; status: "disconnected" }
/** Truncated-text continuation request against one activity item. */
export interface TruncatedTextInput { connectionId: string; threadId: string; itemId: string; textOffset: number }

/**
 * Read-only owner-authorized adapter surface, implemented by `backend.ts` over
 * the existing `/api/t3/*` route handlers. Narrow on purpose: thread launch,
 * follow-up and interrupt are deliberately absent rather than stubbed, because
 * the backend exposes no such contract yet.
 */
export interface T3ReadAdapter {
  listConnections(signal?: AbortSignal): Promise<ConnectionRecord[]>;
  readEnvironment(input: ConnectionReadInput, signal?: AbortSignal): Promise<Environment>;
  readCatalog(input: ConnectionReadInput, signal?: AbortSignal): Promise<Catalog>;
  listProjects(input: ListInput, signal?: AbortSignal): Promise<Page<Project>>;
  readProject(input: ProjectReadInput, signal?: AbortSignal): Promise<Project>;
  listThreads(input: ThreadListInput, signal?: AbortSignal): Promise<Page<Thread>>;
  readThread(input: ThreadReadInput, signal?: AbortSignal): Promise<ThreadDetail>;
  loadTruncatedText(input: TruncatedTextInput, signal?: AbortSignal): Promise<Activity>;
}

/** Connection lifecycle surface. Backend owns OAuth, storage and revocation. */
export interface T3LifecycleAdapter {
  /** Start native OAuth for a new connection; returns the backend-validated consent URL. */
  startOAuth(input: ConnectionInput, signal?: AbortSignal): Promise<OAuthStartResult>;
  /** Re-run native OAuth against an existing connection id without duplicating it. */
  restartOAuth(input: ConnectionReadInput, signal?: AbortSignal): Promise<OAuthStartResult>;
  refresh(input: ConnectionReadInput, signal?: AbortSignal): Promise<{ environment: Environment; observedAt: string }>;
  disconnect(input: ConnectionReadInput, signal?: AbortSignal): Promise<DisconnectResult>;
}
export type T3Adapter = T3ReadAdapter & T3LifecycleAdapter;
export interface DashboardData {
  connection: ConnectionState;
  /** Connection inventory enriched with identity reads for each T3 server. */
  environments: ReadState<Page<ConnectedEnvironment>>;
  projects: ReadState<Page<Project>>;
  catalog: ReadState<Catalog>;
  threads: ReadState<Page<Thread>>;
  /** Keyed by threadDetailKey(connectionId, threadId), never by thread ID alone. */
  details: Readonly<Record<string, ReadState<ThreadDetail>>>;
  /**
   * Detail for the one selected project, read via `t3_project_read`. Kept apart
   * from `projects` so a detail failure never blanks a healthy project list.
   */
  projectDetail: ReadState<Project>;
}
export const unavailableDashboard: DashboardData = {
  connection: { status: "not-connected" },
  environments: { status: "unavailable" }, projects: { status: "unavailable" },
  catalog: { status: "unavailable" }, threads: { status: "unavailable" }, details: {},
  projectDetail: { status: "unavailable" },
};
