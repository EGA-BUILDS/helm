/**
 * Same-origin HTTP adapter for the interrupt and attention routes (EGA-765
 * v0.2 D11).
 *
 * Decoded exactly once here, at the transport boundary, so the interrupt
 * control only ever sees the validated domain types below. A 2xx body that
 * does not match the known projection is an error, never a silent success.
 *
 * Interrupting is never ambient: the adapter only sends when the owner clicks
 * the explicit interrupt control. No Clerk token is sent from the browser.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type InterruptOutcome =
  | "requested"
  | "already_terminal"
  | "no_active_run"
  | "rejected"
  | "ambiguous";

export type InterruptReason =
  | "authorization_required"
  | "expired"
  | "unreachable"
  | "rate_limited"
  | "invalid_run"
  | "project_mismatch"
  | "already_terminal"
  | "inflight_interrupt"
  | "no_active_run"
  | "ambiguous"
  /** Post-dispatch only: the interrupt call was sent and its outcome is unverifiable. */
  | "dispatch_outcome_unknown"
  | "read_failed";

export interface InterruptResult {
  outcome: InterruptOutcome;
  reason: InterruptReason | null;
  detail: string;
  threadId: string | null;
  runId: string | null;
  observedAt: string;
  t3Reference: string;
}

export type AttentionState = "needs_attention" | "running" | "idle" | "unknown";

export interface AttentionResult {
  state: AttentionState;
  basis: string;
  observedAt: string;
  t3Reference: string;
}

export interface InterruptError {
  code: string;
  message: string;
  retryable: boolean;
}

export class InterruptRequestError extends Error {
  readonly interruptError: InterruptError;

  constructor(interruptError: InterruptError) {
    super(interruptError.message);
    this.name = "InterruptRequestError";
    this.interruptError = interruptError;
  }
}

export function toInterruptError(error: unknown): InterruptError {
  if (error instanceof InterruptRequestError) return error.interruptError;
  return { code: "unknown", message: "The native interrupt could not be completed.", retryable: false };
}

function fail(code: string, message: string, retryable = false): never {
  throw new InterruptRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the interrupt backend.`, false);
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

const OUTCOMES: readonly string[] = ["requested", "already_terminal", "no_active_run", "rejected", "ambiguous"];
const REASONS: readonly string[] = [
  "authorization_required",
  "expired",
  "unreachable",
  "rate_limited",
  "invalid_run",
  "project_mismatch",
  "already_terminal",
  "inflight_interrupt",
  "no_active_run",
  "ambiguous",
  "dispatch_outcome_unknown",
  "read_failed",
];
const ATTENTION_STATES: readonly string[] = ["needs_attention", "running", "idle", "unknown"];

export function decodeInterruptResult(value: unknown): InterruptResult {
  const raw = objectAt(value, "the interrupt result");
  const outcome = text(raw.outcome, "an interrupt outcome");
  if (!OUTCOMES.includes(outcome)) return malformed("an interrupt outcome");
  const reasonRaw = raw.reason;
  const reason =
    reasonRaw === null || reasonRaw === undefined
      ? null
      : typeof reasonRaw === "string" && REASONS.includes(reasonRaw)
        ? (reasonRaw as InterruptReason)
        : malformed("an interrupt reason");
  // `requested` is the only outcome without a reason: the request was
  // accepted, and there is nothing to explain. Every other outcome must say
  // why, or the envelope is malformed. For `ambiguous`, the reason carries
  // the sent/not-sent distinction: `dispatch_outcome_unknown` means the
  // interrupt call WAS sent and the acknowledgement was lost or unclear, so
  // the interrupt may or may not have been applied; plain `ambiguous` means
  // the state could not be verified BEFORE any interrupt call.
  if (outcome === "requested" && reason !== null) return malformed("an interrupt reason");
  if (outcome !== "requested" && reason === null) return malformed("an interrupt reason");
  return {
    outcome: outcome as InterruptOutcome,
    reason,
    detail: text(raw.detail, "an interrupt detail"),
    threadId: optionalText(raw.threadId, "an interrupt thread id"),
    runId: optionalText(raw.runId, "an interrupt run id"),
    observedAt: text(raw.observedAt, "an interrupt observation time"),
    t3Reference: text(raw.t3Reference, "a T3 reference"),
  };
}

export function decodeAttentionResult(value: unknown): AttentionResult {
  const raw = objectAt(value, "the attention result");
  const state = text(raw.state, "an attention state");
  if (!ATTENTION_STATES.includes(state)) return malformed("an attention state");
  return {
    state: state as AttentionState,
    basis: text(raw.basis, "an attention basis"),
    observedAt: text(raw.observedAt, "an attention observation time"),
    t3Reference: text(raw.t3Reference, "a T3 reference"),
  };
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the execution service.",
  invalid_request: "That interrupt request was invalid.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The native interrupt could not be completed.",
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
          : "unknown";
    const message = sanitizeMessage(wire?.message) ?? wireErrorMessages[code] ?? wireErrorMessages.unknown!;
    const retryable = code === "backend_unavailable";
    return fail(code, message, retryable);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return malformed("a native interrupt result");
  }
  return body;
}

export interface InterruptInput {
  connectionId: string;
  projectId: string;
  threadId: string;
  runId: string;
  reason?: string;
  clientRequestId?: string;
}

export interface AttentionInput {
  connectionId: string;
  projectId: string;
  threadId: string;
}

export interface InterruptAdapter {
  interrupt(input: InterruptInput, signal?: AbortSignal): Promise<InterruptResult>;
  /**
   * Owner-gated, read-only attention derivation for one thread. Same-origin
   * GET: never mutates, never interrupts, never acknowledges anything.
   */
  attention(input: AttentionInput, signal?: AbortSignal): Promise<AttentionResult>;
}

export function createInterruptAdapter(fetchImpl?: FetchLike): InterruptAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async interrupt(input, signal) {
      const body = await sendWith(call, "/api/t3/threads/interrupt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: input.connectionId,
          projectId: input.projectId,
          threadId: input.threadId,
          runId: input.runId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        }),
        signal,
      });
      return decodeInterruptResult(body);
    },
    async attention(input, signal) {
      const params = new URLSearchParams({
        connectionId: input.connectionId,
        projectId: input.projectId,
        threadId: input.threadId,
      });
      const body = await sendWith(call, `/api/t3/threads/attention?${params.toString()}`, {
        method: "GET",
        signal,
      });
      return decodeAttentionResult(body);
    },
  };
}
