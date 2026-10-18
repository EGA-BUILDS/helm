/**
 * Same-origin HTTP adapter for the `/api/t3/launch` route (EGA-681 D07).
 *
 * Decoded exactly once here, at the transport boundary, so the execute panel
 * only ever sees the validated domain types below. A 2xx body that does not
 * match the known projection is an error, never a silent success.
 *
 * Launching is never ambient: the adapter only sends when the owner clicks
 * the explicit launch control. No Clerk token is sent from the browser.
 */

import {
  decodeAttemptRecovery,
  type AttemptRecovery,
  type RecoverInput,
} from "./recovery";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LaunchOutcome = "launched" | "blocked" | "in_progress" | "ambiguous";

export type LaunchReason =
  | "authorization_required"
  | "expired"
  | "unreachable"
  | "rate_limited"
  | "model_unavailable"
  | "ambiguous"
  | "read_failed";

export interface LaunchResult {
  outcome: LaunchOutcome;
  reason: LaunchReason | null;
  detail: string;
  attemptId: string | null;
  correlationKey: string | null;
  threadId: string | null;
}

export interface LaunchError {
  code: string;
  message: string;
  retryable: boolean;
}

export class LaunchRequestError extends Error {
  readonly launchError: LaunchError;

  constructor(launchError: LaunchError) {
    super(launchError.message);
    this.name = "LaunchRequestError";
    this.launchError = launchError;
  }
}

export function toLaunchError(error: unknown): LaunchError {
  if (error instanceof LaunchRequestError) return error.launchError;
  return { code: "unknown", message: "The native launch could not be completed.", retryable: false };
}

function fail(code: string, message: string, retryable = false): never {
  throw new LaunchRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the launch backend.`, false);
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

const OUTCOMES: readonly string[] = ["launched", "blocked", "in_progress", "ambiguous"];
const REASONS: readonly string[] = [
  "authorization_required",
  "expired",
  "unreachable",
  "rate_limited",
  "model_unavailable",
  "ambiguous",
  "read_failed",
];

export function decodeLaunchResult(value: unknown): LaunchResult {
  const raw = objectAt(value, "the launch result");
  const outcome = text(raw.outcome, "a launch outcome");
  if (!OUTCOMES.includes(outcome)) return malformed("a launch outcome");
  const reasonRaw = raw.reason;
  const reason =
    reasonRaw === null || reasonRaw === undefined
      ? null
      : typeof reasonRaw === "string" && REASONS.includes(reasonRaw)
        ? (reasonRaw as LaunchReason)
        : malformed("a launch reason");
  if ((outcome === "blocked" || outcome === "ambiguous") && reason === null) {
    return malformed("a launch reason");
  }
  return {
    outcome: outcome as LaunchOutcome,
    reason,
    detail: text(raw.detail, "a launch detail"),
    attemptId: optionalText(raw.attemptId, "a launch attempt id"),
    correlationKey: optionalText(raw.correlationKey, "a launch correlation key"),
    threadId: optionalText(raw.threadId, "a launch thread id"),
  };
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the execution service.",
  invalid_request: "That launch request was invalid.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The native launch could not be completed.",
};

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 500 ? cleaned : null;
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
          : response.status === 409
            ? "in_progress"
            : "unknown";
    const message = sanitizeMessage(wire?.message) ?? wireErrorMessages[code] ?? wireErrorMessages.unknown!;
    const retryable = code === "backend_unavailable";
    return fail(code, message, retryable);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return malformed("a native launch result");
  }
  return body;
}

export interface LaunchInput {
  attemptId: string;
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  prompt: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  useSubagents: boolean;
  subagentModel: string | null;
}

export interface LaunchAdapter {
  launch(input: LaunchInput, signal?: AbortSignal): Promise<LaunchResult>;
  /**
   * Owner-gated, read-only recovery for one issue's attempt history.
   * Same-origin GET: the panel calls this on mount and whenever the
   * issue/mapping identity changes, so a hard reload recovers the server's
   * attempt instead of minting a fresh id from empty browser storage.
   */
  recover(input: RecoverInput, signal?: AbortSignal): Promise<AttemptRecovery>;
}

export function createLaunchAdapter(fetchImpl?: FetchLike): LaunchAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async launch(input, signal) {
      const body = await sendWith(call, "/api/t3/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: input.attemptId,
          linearProjectId: input.linearProjectId,
          linearTeamId: input.linearTeamId,
          linearIssueId: input.linearIssueId,
          linearIssueIdentifier: input.linearIssueIdentifier,
          prompt: input.prompt,
          providerInstanceId: input.providerInstanceId,
          model: input.model,
          runtimeMode: input.runtimeMode,
          useSubagents: input.useSubagents,
          ...(input.subagentModel === null ? {} : { subagentModel: input.subagentModel }),
        }),
        signal,
      });
      return decodeLaunchResult(body);
    },
    async recover(input, signal) {
      const params = new URLSearchParams({
        linearProjectId: input.linearProjectId,
        linearTeamId: input.linearTeamId,
        linearIssueId: input.linearIssueId,
      });
      const body = await sendWith(call, `/api/t3/launch?${params.toString()}`, {
        method: "GET",
        signal,
      });
      return decodeAttemptRecovery(body);
    },
  };
}
