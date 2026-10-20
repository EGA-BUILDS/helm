/**
 * Same-origin HTTP adapter for the manual thread↔issue link routes (B4).
 *
 * Decoded exactly once here, at the transport boundary, so the control only
 * ever sees the validated domain types below. A 2xx body that does not match
 * the known projection is an error, never a silent success.
 *
 * Linking is a binding only: these routes never change a Linear issue state,
 * never launch or message a T3 thread, and never touch Git. No Clerk token is
 * sent from the browser; the route handlers read the ambient same-origin
 * session and enforce the Convex owner grant themselves.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ManualLinkIdentity {
  connectionId: string;
  projectId: string;
  threadId: string;
}

export interface ManualLinkAssociation {
  associationId: string;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  t3ConnectionId: string;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ThreadId: string;
  attemptId: string;
  correlationKey: string;
  unlinkedAt: number;
  createdAt: number;
  note: string | null;
  /** Derived: an empty attemptId means a manual binding (no launch evidence). */
  provenance: "manual" | "launch";
  /** Ledger state when known (e.g. "linked"). */
  ledgerState: string | null;
}

export interface LinkResult {
  associationId: string;
  created: boolean;
}

export interface UnlinkResult {
  removed: boolean;
  deleted: boolean;
  unlinked: boolean;
  associationId: string | null;
}

export interface ReassignResult {
  associationId: string;
  created: boolean;
}

export interface ManualLinkError {
  code: string;
  message: string;
  retryable: boolean;
}

export class ManualLinkRequestError extends Error {
  readonly manualLinkError: ManualLinkError;

  constructor(manualLinkError: ManualLinkError) {
    super(manualLinkError.message);
    this.name = "ManualLinkRequestError";
    this.manualLinkError = manualLinkError;
  }
}

export function toManualLinkError(error: unknown): ManualLinkError {
  if (error instanceof ManualLinkRequestError) return error.manualLinkError;
  return { code: "unknown", message: "The manual link request could not be completed.", retryable: true };
}

function fail(code: string, message: string, retryable = false): never {
  throw new ManualLinkRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the manual link backend.`, false);
}

type Json = Record<string, unknown>;

function objectAt(value: unknown, what: string): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Json;
  }
  return malformed(what);
}

function text(value: unknown, what: string): string {
  return typeof value === "string" && value.length > 0 ? value : malformed(what);
}

function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : malformed(what);
}

function numberAt(value: unknown, what: string): number {
  return typeof value === "number" ? value : malformed(what);
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the manual link service.",
  invalid_request: "That manual link request was invalid.",
  not_found: "That association no longer exists.",
  conflict: "The thread's association changed concurrently; retry with the current association.",
  revoked: "Linear authorization was revoked. Reconnect to continue.",
  connection_expired: "This authorization expired. Reconnect to continue.",
  rate_limited: "The service is receiving too many requests. Try again shortly.",
  misconfigured: "Helm's manual link service is not fully configured.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The manual link request could not be completed.",
};

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 300 ? cleaned : null;
}

async function sendWith(call: FetchLike, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await call(path, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    return fail("backend_unavailable", wireErrorMessages.backend_unavailable!, true);
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
    const code = typeof wire?.code === "string" ? wire.code : response.status === 401 ? "access_denied" : "unknown";
    // Preserve backend messages that name a conflict so the UI can react.
    const message = sanitizeMessage(wire?.message) ?? wireErrorMessages[code] ?? wireErrorMessages.unknown!;
    const retryable = code === "backend_unavailable" || code === "rate_limited" || code === "unknown";
    return fail(code, message, retryable);
  }
  if (response.status === 204) return null;
  if (typeof body !== "object" || body === null) return malformed("a manual link result");
  return body;
}

function decodeAssociation(raw: unknown): ManualLinkAssociation | null {
  if (raw === null || raw === undefined) return null;
  let source: unknown = raw;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const obj = source as Json;
    if ("association" in obj && obj.association !== undefined) source = obj.association;
  }
  if (source === null || source === undefined) return null;
  const r = objectAt(source, "a manual association");
  const attemptId = typeof r.attemptId === "string" ? r.attemptId : "";
  const provenance: "manual" | "launch" = attemptId === "" ? "manual" : "launch";
  return {
    associationId: text(r.associationId ?? r._id, "an association id"),
    linearWorkspaceId: text(r.linearWorkspaceId, "a Linear workspace id"),
    linearProjectId: text(r.linearProjectId, "a Linear project id"),
    linearTeamId: text(r.linearTeamId, "a Linear team id"),
    linearIssueId: text(r.linearIssueId, "a Linear issue id"),
    linearIssueIdentifier: text(r.linearIssueIdentifier, "a Linear issue identifier"),
    t3ConnectionId: String(r.t3ConnectionId),
    t3EnvironmentId: text(r.t3EnvironmentId, "a T3 environment id"),
    t3ProjectId: text(r.t3ProjectId, "a T3 project id"),
    t3ThreadId: text(r.t3ThreadId, "a T3 thread id"),
    attemptId,
    correlationKey: typeof r.correlationKey === "string" ? r.correlationKey : "",
    unlinkedAt: numberAt(r.unlinkedAt, "an unlinked timestamp"),
    createdAt: numberAt(r.createdAt, "a created timestamp"),
    note: optionalText(r.note, "an association note"),
    provenance,
    ledgerState: optionalText(r.state ?? r.ledgerState, "a ledger state"),
  };
}

export function decodeLinkResult(value: unknown): LinkResult {
  const raw = objectAt(value, "a link result");
  return {
    associationId: text(raw.associationId, "an association id"),
    created: typeof raw.created === "boolean" ? raw.created : malformed("a created flag"),
  };
}

export function decodeUnlinkResult(value: unknown): UnlinkResult {
  const raw = objectAt(value, "an unlink result");
  return {
    removed: typeof raw.removed === "boolean" ? raw.removed : malformed("a removed flag"),
    deleted: typeof raw.deleted === "boolean" ? raw.deleted : malformed("a deleted flag"),
    unlinked: typeof raw.unlinked === "boolean" ? raw.unlinked : malformed("an unlinked flag"),
    associationId: raw.associationId === null || raw.associationId === undefined
      ? null
      : text(raw.associationId, "an association id"),
  };
}

export function decodeReassignResult(value: unknown): ReassignResult {
  const raw = objectAt(value, "a reassign result");
  return {
    associationId: text(raw.associationId, "an association id"),
    created: typeof raw.created === "boolean" ? raw.created : malformed("a created flag"),
  };
}

export interface ManualLinkAdapter {
  readAssociation(input: ManualLinkIdentity, signal?: AbortSignal): Promise<ManualLinkAssociation | null>;
  link(input: {
    connectionId: string;
    projectId: string;
    threadId: string;
    linearWorkspaceId?: string;
    linearProjectId: string;
    linearTeamId: string;
    linearIssueId: string;
    linearIssueIdentifier: string;
    confirm?: boolean;
    confirmLaunchEvidenceLoss?: boolean;
    expectedAssociationId?: string;
    note?: string;
  }, signal?: AbortSignal): Promise<LinkResult>;
  unlink(input: {
    connectionId: string;
    projectId: string;
    threadId: string;
    confirm: boolean;
    expectedAssociationId: string;
    note?: string;
  }, signal?: AbortSignal): Promise<UnlinkResult>;
  reassign(input: {
    connectionId: string;
    projectId: string;
    threadId: string;
    linearWorkspaceId?: string;
    linearProjectId: string;
    linearTeamId: string;
    linearIssueId: string;
    linearIssueIdentifier: string;
    confirm: boolean;
    confirmLaunchEvidenceLoss?: boolean;
    expectedAssociationId: string;
    note?: string;
  }, signal?: AbortSignal): Promise<ReassignResult>;
}

export function createManualLinkAdapter(fetchImpl?: FetchLike): ManualLinkAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));

  function readUrl(input: ManualLinkIdentity): string {
    const params = new URLSearchParams({
      connectionId: input.connectionId,
      projectId: input.projectId,
      threadId: input.threadId,
    });
    return `/api/t3/manual-link?${params.toString()}`;
  }

  return {
    async readAssociation(input, signal) {
      const body = await sendWith(call, readUrl(input), { method: "GET", signal });
      return decodeAssociation(body);
    },
    async link(input, signal) {
      const body = await sendWith(call, "/api/t3/manual-link/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      return decodeLinkResult(body);
    },
    async unlink(input, signal) {
      const body = await sendWith(call, "/api/t3/manual-link/unlink", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      return decodeUnlinkResult(body);
    },
    async reassign(input, signal) {
      const body = await sendWith(call, "/api/t3/manual-link/reassign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      return decodeReassignResult(body);
    },
  };
}
