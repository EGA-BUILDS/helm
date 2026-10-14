/**
 * Same-origin HTTP adapter for the existing `/api/t3/*` route handlers.
 *
 * Every response is decoded exactly once here, at the transport boundary, so the
 * dashboard only ever sees the validated domain types in `contract.ts`. A 2xx
 * body that does not match the known projection is treated as an error; it is
 * never downgraded into an empty successful page.
 *
 * No Clerk token is sent from the browser. The route handlers read the ambient
 * same-origin session and enforce the Convex owner grant themselves.
 */

import type {
  AccessLevel,
  Activity,
  Catalog,
  ConnectionErrorCode,
  ConnectionRecord,
  ConnectionStatus,
  Environment,
  ErrorCode,
  Freshness,
  Metadata,
  Model,
  OAuthStartResult,
  OrchestrationFeatures,
  Project,
  Provider,
  Thread,
  ThreadDetail,
  ThreadRun,
  T3Adapter,
  T3LifecycleAdapter,
  T3ReadAdapter,
  TruncatedTextInput,
  UiError,
} from "./contract";

/** Must match `TRUSTED_DOMAIN` in `convex/t3OAuth.ts`; the backend still re-checks. */
const TRUSTED_T3_HOST = "t3coderelay.com";

type Json = Record<string, unknown>;

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/** Carries an already-sanitized `UiError` so the UI never renders a raw failure. */
export class T3RequestError extends Error {
  readonly uiError: UiError;

  constructor(uiError: UiError) {
    super(uiError.message);
    this.name = "T3RequestError";
    this.uiError = uiError;
  }
}

export function toUiError(error: unknown): UiError {
  if (error instanceof T3RequestError) return error.uiError;
  return { code: "unknown", message: "The T3 request could not be completed.", retryable: true };
}

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw new T3RequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the T3 backend.`, true);
}

/* ---------------------------------------------------------------- decoders */

function objectAt(value: unknown, what: string): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : malformed(what);
}

function text(value: unknown, what: string): string {
  return typeof value === "string" && value.length > 0 ? value : malformed(what);
}

function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : malformed(what);
}

function requiredNumber(value: unknown, what: string): number {
  const parsed = optionalNumber(value, what);
  return parsed === null ? malformed(what) : parsed;
}

/** `0` is a valid cursor, so callers must compare against `null`, never falsiness. */
function optionalNumber(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return malformed(what);
  return value;
}

function flag(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : malformed(what);
}

function optionalFlag(value: unknown, what: string): boolean | null {
  if (value === null || value === undefined) return null;
  return flag(value, what);
}

function listAt(value: unknown, what: string): readonly unknown[] {
  return Array.isArray(value) ? value : malformed(what);
}

function optionalList(value: unknown, what: string): readonly unknown[] | null {
  if (value === null || value === undefined) return null;
  return listAt(value, what);
}

function optionalObject(value: unknown, what: string): Metadata {
  if (value === null || value === undefined) return null;
  return typeof value === "object" && !Array.isArray(value) ? (value as Json) : malformed(what);
}

/** Backend error codes mapped onto the UI vocabulary; unknown codes stay sanitized. */
const wireErrorCodes: Readonly<Record<string, ErrorCode>> = {
  access_denied: "access_denied",
  backend_unavailable: "backend_unavailable",
  invalid_endpoint: "invalid_endpoint",
  invalid_request: "unknown",
  not_found: "not_found",
  cursor_invalid: "cursor_invalid",
  revoked: "revoked",
  connection_expired: "connection_expired",
  rate_limited: "rate_limited",
  read_failed: "read_failed",
  unreachable: "unreachable",
};

const wireErrorMessages: Readonly<Partial<Record<ErrorCode, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the T3 connection service.",
  invalid_endpoint: "Enter a supported trusted T3 Connect endpoint.",
  not_found: "That T3 resource no longer exists.",
  cursor_invalid: "That page cursor is no longer valid. Reload the list and try again.",
  revoked: "T3 authorization was revoked. Reconnect to continue.",
  connection_expired: "This T3 authorization expired. Reconnect to continue.",
  rate_limited: "T3 is receiving too many requests. Try again shortly.",
  read_failed: "T3 could not complete the read.",
  unreachable: "The T3 endpoint could not be reached. Try again later.",
  unknown: "The T3 request could not be completed.",
};

export function connectionStatus(value: unknown): ConnectionStatus | null {
  return value === "connected" || value === "disconnected" || value === "expired" ||
    value === "revoked" || value === "unreachable" ? value : null;
}

/** An unrecognized value is unknown, not an error; a wrong *type* is malformed. */
export function connectionErrorCode(value: unknown): ConnectionErrorCode | null {
  const raw = optionalText(value, "a connection error code");
  return raw === "authorization_required" || raw === "authorization_expired" ||
    raw === "endpoint_identity_changed" || raw === "rate_limited" ||
    raw === "read_failed" || raw === "unreachable" ? raw : null;
}

function accessLevel(value: unknown): AccessLevel | null {
  const raw = optionalText(value, "a connection access level");
  return raw === "read-only" || raw === "supervised" || raw === "full-access" ? raw : null;
}

export function decodeConnection(value: unknown): ConnectionRecord {
  const raw = objectAt(value, "a T3 connection");
  const status = connectionStatus(raw.status);
  if (!status) return malformed("the connection status");
  return {
    connectionId: text(raw.connectionId, "a connection id"),
    displayName: optionalText(raw.displayName, "a connection name"),
    endpoint: text(raw.endpoint, "a connection endpoint"),
    environmentId: optionalText(raw.environmentId, "a connection environment id"),
    access: accessLevel(raw.access),
    status,
    lastVerifiedAt: optionalText(raw.lastVerifiedAt, "a verification time"),
    lastReadAt: optionalText(raw.lastReadAt, "a last-read time"),
    errorCode: connectionErrorCode(raw.errorCode),
    expiresAt: optionalText(raw.expiresAt, "a connection expiry"),
  };
}

export function decodeEnvironment(value: unknown): Environment {
  const raw = objectAt(value, "the T3 environment");
  return {
    environmentId: text(raw.environmentId, "the environment id"),
    label: optionalText(raw.label, "the environment label"),
    serverVersion: optionalText(raw.serverVersion, "the server version"),
    platform: optionalText(raw.platform, "the platform"),
    metadata: optionalObject(raw.metadata, "the environment metadata"),
  };
}

function decodeModel(value: unknown): Model {
  const raw = objectAt(value, "a model");
  return {
    id: text(raw.id, "a model id"),
    label: optionalText(raw.label, "a model label"),
    options: optionalList(raw.options, "model options"),
  };
}

function decodeProvider(value: unknown): Provider {
  const raw = objectAt(value, "a provider");
  const models = optionalList(raw.models, "provider models");
  const runtimeModes = optionalList(raw.runtimeModes, "provider runtime modes");
  const constraints = optionalList(raw.constraints, "provider constraints");
  return {
    providerInstanceId: text(raw.providerInstanceId, "a provider id"),
    driverKind: optionalText(raw.driverKind, "a provider driver kind"),
    displayName: optionalText(raw.displayName, "a provider name"),
    models: models === null ? null : models.map(decodeModel),
    runtimeModes: runtimeModes === null ? null : runtimeModes.map((mode) => text(mode, "a provider runtime mode")),
    canRunChildTask: optionalFlag(raw.canRunChildTask, "a provider child-task capability"),
    canRunCrossProviderChildTask: optionalFlag(raw.canRunCrossProviderChildTask, "a provider cross-provider capability"),
    // Discovery never proves authentication or availability, so both stay null.
    authenticationStatus: null,
    availability: null,
    constraints: constraints === null ? null : constraints.map((item) => text(item, "a provider constraint")),
  };
}

function decodeFeatures(value: unknown): OrchestrationFeatures {
  const raw = objectAt(value, "the orchestration features");
  return {
    appOwnedSubagents: optionalFlag(raw.appOwnedSubagents, "an app-owned subagent feature"),
    asyncPolling: optionalFlag(raw.asyncPolling, "an async polling feature"),
    cancellation: optionalFlag(raw.cancellation, "a cancellation feature"),
    batchThreadCreation: optionalFlag(raw.batchThreadCreation, "a batch thread creation feature"),
    threadManagement: optionalFlag(raw.threadManagement, "a thread management feature"),
    incrementalThreadRead: optionalFlag(raw.incrementalThreadRead, "an incremental thread read feature"),
    scheduledTasks: optionalFlag(raw.scheduledTasks, "a scheduled tasks feature"),
    maxBatchThreads: optionalNumber(raw.maxBatchThreads, "a batch thread limit"),
  };
}

export function decodeCatalog(value: unknown, freshness: Freshness): Catalog {
  const raw = objectAt(value, "the provider catalog");
  return {
    providers: listAt(raw.providers, "the provider list").map(decodeProvider),
    features: raw.features === null || raw.features === undefined ? null : decodeFeatures(raw.features),
    runtimeMode: optionalText(raw.runtimeMode, "the runtime mode"),
    interactionMode: optionalText(raw.interactionMode, "the interaction mode"),
    parentThreadId: optionalText(raw.parentThreadId, "the parent thread id"),
    inheritedProviderInstanceId: optionalText(raw.inheritedProviderInstanceId, "the inherited provider id"),
    inheritedModel: optionalText(raw.inheritedModel, "the inherited model"),
    freshness,
  };
}

export function decodeProject(value: unknown): Project {
  const raw = objectAt(value, "a project");
  return {
    connectionId: text(raw.connectionId, "a project connection"),
    projectId: text(raw.projectId, "a project id"),
    environmentId: text(raw.environmentId, "a project environment"),
    title: optionalText(raw.title, "a project title"),
    status: optionalText(raw.status, "a project status"),
    workspaceRoot: optionalText(raw.workspaceRoot, "a project workspace"),
    repositoryIdentity: optionalText(raw.repositoryIdentity, "a project repository identity"),
    defaultModel: optionalText(raw.defaultModel, "a project default model"),
  };
}

export function decodeThread(value: unknown): Thread {
  const raw = objectAt(value, "a thread");
  return {
    connectionId: text(raw.connectionId, "a thread connection"),
    threadId: text(raw.threadId, "a thread id"),
    projectId: text(raw.projectId, "a thread project"),
    environmentId: text(raw.environmentId, "a thread environment"),
    title: optionalText(raw.title, "a thread title"),
    status: optionalText(raw.status, "a thread status"),
    providerInstanceId: optionalText(raw.providerInstanceId, "a thread provider"),
    model: optionalText(raw.model, "a thread model"),
    runtimeMode: optionalText(raw.runtimeMode, "a thread runtime mode"),
    interactionMode: optionalText(raw.interactionMode, "a thread interaction mode"),
    branch: optionalText(raw.branch, "a thread branch"),
    worktreePath: optionalText(raw.worktreePath, "a thread worktree"),
    latestRunId: optionalText(raw.latestRunId, "a thread latest run id"),
    parentThreadId: optionalText(raw.parentThreadId, "a thread parent id"),
    linkedPullRequest: optionalObject(raw.linkedPullRequest, "a linked pull request"),
    updatedAt: optionalText(raw.updatedAt, "a thread update time"),
  };
}

export function decodeActivity(value: unknown): Activity {
  const raw = objectAt(value, "a thread activity item");
  return {
    id: text(raw.id, "an activity id"),
    position: requiredNumber(raw.position, "an activity position"),
    kind: optionalText(raw.kind, "an activity kind"),
    text: optionalText(raw.text, "activity text"),
    createdAt: optionalText(raw.createdAt, "an activity time"),
    truncated: flag(raw.truncated, "an activity truncation flag"),
    nextTextOffset: optionalNumber(raw.nextTextOffset, "an activity text offset"),
  };
}

function decodeRun(value: unknown): ThreadRun {
  const raw = objectAt(value, "a thread run");
  return {
    runId: text(raw.runId, "a run id"),
    ordinal: optionalNumber(raw.ordinal, "a run ordinal"),
    status: optionalText(raw.status, "a run status"),
    providerInstanceId: optionalText(raw.providerInstanceId, "a run provider"),
    model: optionalText(raw.model, "a run model"),
    requestedAt: optionalText(raw.requestedAt, "a run request time"),
    startedAt: optionalText(raw.startedAt, "a run start time"),
    completedAt: optionalText(raw.completedAt, "a run completion time"),
  };
}

export function decodeThreadDetail(value: unknown, freshness: Freshness): ThreadDetail {
  const raw = objectAt(value, "a thread detail");
  return {
    thread: decodeThread(objectAt(raw.thread, "the requested thread")),
    items: listAt(raw.items, "the activity list").map(decodeActivity),
    recentRuns: listAt(raw.recentRuns, "the recent run list").map(decodeRun),
    nextPosition: optionalNumber(raw.nextPosition, "the next activity position"),
    hasMore: flag(raw.hasMore, "the activity pagination flag"),
    freshness,
  };
}

function decodeItems<T>(value: unknown, decode: (item: unknown) => T) {
  const raw = objectAt(value, "a page of results");
  return {
    items: listAt(raw.items, "a result page").map(decode),
    nextCursor: optionalNumber(raw.nextCursor, "a page cursor"),
    total: optionalNumber(raw.total, "a result total"),
  };
}

/** Envelope shared by every `/api/t3/connections/:id/:operation` read. */
function decodeEnvelope(value: unknown): { data: unknown; freshness: Freshness } {
  const raw = objectAt(value, "a T3 read result");
  const envelope = typeof raw.freshness === "object" && raw.freshness !== null ? (raw.freshness as Json) : {};
  return {
    data: raw.data,
    freshness: {
      source: "backend",
      observedAt: text(raw.observedAt, "an observation time"),
      stale: typeof envelope.stale === "boolean" ? envelope.stale : malformed("the freshness state"),
    },
  };
}

/* --------------------------------------------------------------- transport */

/** Sanitize a backend message: short, single-line, no control characters. */
function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 300 ? cleaned : null;
}

async function sendWith(call: FetchLike, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await call(path, { ...init, signal, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    // An aborted request is a deliberate cancellation, not a transport failure.
    if (signal?.aborted) throw error;
    return fail("backend_unavailable", "Helm could not reach the T3 connection service.", true);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const wire = typeof body === "object" && body !== null && !Array.isArray(body)
      ? ((body as Json).error as Json | undefined)
      : undefined;
    const code = typeof wire?.code === "string" ? wireErrorCodes[wire.code] : undefined;
    const resolved = code ?? (response.status === 401 ? "access_denied" : response.status === 404 ? "not_found" : "unknown");
    return fail(resolved, sanitizeMessage(wire?.message) ?? wireErrorMessages[resolved] ?? wireErrorMessages.unknown!, resolved === "rate_limited" || resolved === "read_failed" || resolved === "unreachable" || resolved === "backend_unavailable");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return malformed("a T3 read result");
  return body;
}

function connectionPath(connectionId: string, suffix = ""): string {
  return `/api/t3/connections/${encodeURIComponent(connectionId)}${suffix}`;
}

function queryString(params: Record<string, string | number | readonly string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "string") search.set(key, value);
    else if (typeof value === "number") search.set(key, String(value));
    else for (const item of value) search.append(key, item);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * The backend only serves consent from its own trusted T3 relay origin. The
 * browser re-checks the destination before navigating, so a compromised or
 * confused response cannot turn Connect into an off-origin redirect.
 */
export function isApprovedAuthorizationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === TRUSTED_T3_HOST || url.hostname.endsWith(`.${TRUSTED_T3_HOST}`));
}

function decodeOAuthStart(value: unknown): OAuthStartResult {
  const raw = objectAt(value, "the OAuth start result");
  const authorizationUrl = text(raw.authorizationUrl, "the consent URL");
  return {
    attemptId: text(raw.attemptId, "an OAuth attempt id"),
    authorizationUrl,
    expiresAt: optionalText(raw.expiresAt, "an OAuth attempt expiry"),
  };
}

export function createT3Adapter(fetchImpl?: FetchLike): T3Adapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const send = (path: string, init: RequestInit, signal?: AbortSignal) => sendWith(call, path, init, signal);

  async function readOperation(
    connectionId: string,
    operation: string,
    params: Record<string, string | number | readonly string[] | undefined>,
    signal?: AbortSignal,
  ) {
    return decodeEnvelope(await send(`${connectionPath(connectionId, `/${operation}`)}${queryString(params)}`, { method: "GET" }, signal));
  }

  const reads: T3ReadAdapter = {
    async listConnections(signal) {
      const body = await send("/api/t3/connections", { method: "GET" }, signal);
      return listAt(objectAt(body, "the connection inventory").connections, "the connection inventory").map(decodeConnection);
    },
    async readEnvironment(input, signal) {
      const { data } = await readOperation(input.connectionId, "environment", {}, signal);
      return decodeEnvironment(data);
    },
    async readCatalog(input, signal) {
      const { data, freshness } = await readOperation(input.connectionId, "capabilities", {}, signal);
      return decodeCatalog(data, freshness);
    },
    async listProjects(input, signal) {
      const { data, freshness } = await readOperation(input.connectionId, "projects", { cursor: input.cursor, limit: input.limit }, signal);
      return { ...decodeItems(data, decodeProject), freshness };
    },
    async readProject(input, signal) {
      const { data } = await readOperation(input.connectionId, "project", { projectId: input.projectId }, signal);
      const project = decodeProject(data);
      // A detail read is only trustworthy if it describes the project we asked
      // for. A mismatched identity is rejected here rather than rendered.
      if (project.projectId !== input.projectId || project.connectionId !== input.connectionId) {
        return malformed("the project identity") as never;
      }
      return project;
    },
    async listThreads(input, signal) {
      const { data, freshness } = await readOperation(input.connectionId, "threads", {
        projectId: input.projectId, cursor: input.cursor, limit: input.limit,
        titleContains: input.titleContains, statuses: input.statuses,
      }, signal);
      return { ...decodeItems(data, decodeThread), freshness };
    },
    async readThread(input, signal) {
      const { data, freshness } = await readOperation(input.connectionId, "thread", {
        threadId: input.threadId, afterPosition: input.afterPosition, limit: input.limit,
        itemId: input.itemId, textOffset: input.textOffset, view: input.view,
      }, signal);
      return decodeThreadDetail(data, freshness);
    },
    async loadTruncatedText(input: TruncatedTextInput, signal) {
      const detail = await reads.readThread({
        connectionId: input.connectionId, threadId: input.threadId, itemId: input.itemId, textOffset: input.textOffset,
      }, signal);
      const item = detail.items.find((entry) => entry.id === input.itemId);
      if (!item) return fail("not_found", "T3 returned no continuation for that activity item.");
      return item;
    },
  };

  const lifecycle: T3LifecycleAdapter = {
    async startOAuth(input, signal) {
      const body = await send("/api/t3/oauth/start", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: input.endpoint }),
      }, signal);
      return decodeOAuthStart(body);
    },
    async restartOAuth(input, signal) {
      const body = await send("/api/t3/oauth/start", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: input.connectionId }),
      }, signal);
      return decodeOAuthStart(body);
    },
    async refresh(input, signal) {
      const body = objectAt(await send(connectionPath(input.connectionId, "/refresh"), { method: "POST" }, signal), "a refresh result");
      const data = objectAt(body.data, "a refresh result");
      return { environment: decodeEnvironment(data.environment), observedAt: text(data.observedAt, "an observation time") };
    },
    async disconnect(input, signal) {
      const body = objectAt(await send(connectionPath(input.connectionId), { method: "DELETE" }, signal), "a disconnect result");
      return { connectionId: text(body.connectionId, "a connection id"), status: "disconnected" };
    },
  };

  return { ...reads, ...lifecycle };
}