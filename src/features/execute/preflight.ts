/**
 * Same-origin HTTP adapter for the `/api/execution/preflight` route.
 *
 * Decoded exactly once here, at the transport boundary, so the review panel
 * only ever sees the validated domain types below. A 2xx body that does not
 * match the known projection is an error, never an empty successful verdict.
 *
 * Read-only: this adapter never launches anything and never writes a Linear
 * status. No Clerk token is sent from the browser.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PreflightError {
  code: string;
  message: string;
  retryable: boolean;
}

export class PreflightRequestError extends Error {
  readonly preflightError: PreflightError;

  constructor(preflightError: PreflightError) {
    super(preflightError.message);
    this.name = "PreflightRequestError";
    this.preflightError = preflightError;
  }
}

export function toPreflightError(error: unknown): PreflightError {
  if (error instanceof PreflightRequestError) return error.preflightError;
  return { code: "unknown", message: "The execution preflight could not be completed.", retryable: true };
}

function fail(code: string, message: string, retryable = false): never {
  throw new PreflightRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the execution backend.`, true);
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

function flag(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : malformed(what);
}

export interface PreflightModel {
  id: string;
  label: string | null;
}

export interface PreflightProvider {
  providerInstanceId: string;
  displayName: string | null;
  models: PreflightModel[];
}

export interface PreflightCatalog {
  providers: PreflightProvider[];
  runtimeMode: string | null;
  freshness: { source: string; observedAt: string; stale: boolean };
}

export interface PreflightVerdict {
  linearProjectId: string;
  linearTeamId: string;
  t3ConnectionId: string | null;
  t3EnvironmentId: string | null;
  t3ProjectId: string | null;
  t3ProjectTitle: string | null;
  worktreeBaseRef: string | null;
  targetBranch: string | null;
  startedStateId: string | null;
  catalog: PreflightCatalog | null;
  catalogError: string | null;
  blockers: string[];
}

function decodeModel(value: unknown): PreflightModel {
  const raw = objectAt(value, "a T3 model");
  return { id: text(raw.id, "a model id"), label: optionalText(raw.label, "a model label") };
}

function decodeProvider(value: unknown): PreflightProvider {
  const raw = objectAt(value, "a T3 provider");
  const models = Array.isArray(raw.models) ? raw.models : malformed("provider models");
  return {
    providerInstanceId: text(raw.providerInstanceId, "a provider id"),
    displayName: optionalText(raw.displayName, "a provider name"),
    models: models.map(decodeModel),
  };
}

function decodeCatalog(value: unknown): PreflightCatalog {
  const raw = objectAt(value, "the T3 catalog snapshot");
  const providers = Array.isArray(raw.providers) ? raw.providers : malformed("provider list");
  const freshness = objectAt(raw.freshness, "catalog freshness");
  return {
    providers: providers.map(decodeProvider),
    runtimeMode: optionalText(raw.runtimeMode, "a runtime mode"),
    freshness: {
      source: text(freshness.source, "a freshness source"),
      observedAt: text(freshness.observedAt, "a freshness timestamp"),
      stale: flag(freshness.stale, "a freshness flag"),
    },
  };
}

function decodeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) malformed("the blocker list");
  return (value as unknown[]).map((entry) =>
    typeof entry === "string" ? entry : malformed("the blocker list"),
  );
}

export function decodePreflight(value: unknown): PreflightVerdict {
  const raw = objectAt(value, "the execution preflight");
  const catalogRaw = raw.catalog;
  const catalog = catalogRaw === null || catalogRaw === undefined ? null : decodeCatalog(catalogRaw);
  return {
    linearProjectId: text(raw.linearProjectId, "a Linear project id"),
    linearTeamId: text(raw.linearTeamId, "a Linear team id"),
    t3ConnectionId: optionalText(raw.t3ConnectionId, "a T3 connection id"),
    t3EnvironmentId: optionalText(raw.t3EnvironmentId, "a T3 environment id"),
    t3ProjectId: optionalText(raw.t3ProjectId, "a T3 project id"),
    t3ProjectTitle: optionalText(raw.t3ProjectTitle, "a T3 project title"),
    worktreeBaseRef: optionalText(raw.worktreeBaseRef, "a worktree baseRef"),
    targetBranch: optionalText(raw.targetBranch, "a PR target branch"),
    startedStateId: optionalText(raw.startedStateId, "a started workflow state"),
    catalog,
    catalogError: optionalText(raw.catalogError, "a catalog error"),
    blockers: decodeStrings(raw.blockers),
  };
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the execution service.",
  invalid_request: "That execution request was invalid.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The execution preflight could not be completed.",
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
    const wire =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? ((body as Json).error as Json | undefined)
        : undefined;
    const code =
      typeof wire?.code === "string"
        ? wire.code
        : response.status === 401
          ? "access_denied"
          : "unknown";
    const message = sanitizeMessage(wire?.message) ?? wireErrorMessages[code] ?? wireErrorMessages.unknown!;
    const retryable = code === "backend_unavailable" || code === "unknown";
    return fail(code, message, retryable);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return malformed("an execution preflight");
  }
  return body;
}

export interface PreflightAdapter {
  checkPreflight(
    input: { linearProjectId: string; linearTeamId: string },
    signal?: AbortSignal,
  ): Promise<PreflightVerdict>;
}

export function createPreflightAdapter(fetchImpl?: FetchLike): PreflightAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async checkPreflight(input, signal) {
      const body = await sendWith(call, "/api/execution/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      return decodePreflight(body);
    },
  };
}
