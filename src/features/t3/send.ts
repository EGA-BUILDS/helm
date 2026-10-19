/**
 * Same-origin HTTP adapter for the `/api/t3/threads/send` route (EGA-764 D10).
 *
 * Decoded exactly once here, at the transport boundary, so the follow-up
 * control only ever sees the validated domain types below. A 2xx body that
 * does not match the known projection is an error, never a silent success.
 *
 * Sending is never ambient: the adapter only sends when the owner clicks the
 * explicit send control. No Clerk token is sent from the browser.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SendOutcome = "accepted" | "queued" | "rejected" | "ambiguous";

export type SendReason =
  | "authorization_required"
  | "expired"
  | "unreachable"
  | "rate_limited"
  | "not_found"
  | "rejected"
  | "ambiguous"
  | "read_failed";

export interface SendResult {
  outcome: SendOutcome;
  reason: SendReason | null;
  detail: string;
  threadId: string;
  messageId: string | null;
  runId: string | null;
  clientRequestId: string;
  duplicateSuppressed: boolean;
}

export interface SendError {
  code: string;
  message: string;
  retryable: boolean;
}

export class SendRequestError extends Error {
  readonly sendError: SendError;

  constructor(sendError: SendError) {
    super(sendError.message);
    this.name = "SendRequestError";
    this.sendError = sendError;
  }
}

export function toSendError(error: unknown): SendError {
  if (error instanceof SendRequestError) return error.sendError;
  return { code: "unknown", message: "The follow-up message could not be sent.", retryable: false };
}

function fail(code: string, message: string, retryable = false): never {
  throw new SendRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the follow-up backend.`, false);
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

const OUTCOMES: readonly string[] = ["accepted", "queued", "rejected", "ambiguous"];
const REASONS: readonly string[] = [
  "authorization_required",
  "expired",
  "unreachable",
  "rate_limited",
  "not_found",
  "rejected",
  "ambiguous",
  "read_failed",
];

export function decodeSendResult(value: unknown): SendResult {
  const raw = objectAt(value, "the follow-up result");
  const outcome = text(raw.outcome, "a follow-up outcome");
  if (!OUTCOMES.includes(outcome)) return malformed("a follow-up outcome");
  const reasonRaw = raw.reason;
  const reason =
    reasonRaw === null || reasonRaw === undefined
      ? null
      : typeof reasonRaw === "string" && REASONS.includes(reasonRaw)
        ? (reasonRaw as SendReason)
        : malformed("a follow-up reason");
  if ((outcome === "rejected" || outcome === "ambiguous") && reason === null) {
    return malformed("a follow-up reason");
  }
  return {
    outcome: outcome as SendOutcome,
    reason,
    detail: text(raw.detail, "a follow-up detail"),
    threadId: text(raw.threadId, "a follow-up thread id"),
    messageId: optionalText(raw.messageId, "a follow-up message id"),
    runId: optionalText(raw.runId, "a follow-up run id"),
    clientRequestId: text(raw.clientRequestId, "a follow-up request id"),
    duplicateSuppressed: flag(raw.duplicateSuppressed, "a follow-up duplicate flag"),
  };
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the follow-up service.",
  invalid_request: "That follow-up request was invalid.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The follow-up message could not be sent.",
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
    return malformed("a native follow-up result");
  }
  return body;
}

export interface SendInput {
  connectionId: string;
  projectId: string;
  threadId: string;
  message: string;
  clientRequestId: string;
}

export interface SendAdapter {
  send(input: SendInput, signal?: AbortSignal): Promise<SendResult>;
}

export function createSendAdapter(fetchImpl?: FetchLike): SendAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async send(input, signal) {
      const body = await sendWith(call, "/api/t3/threads/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: input.connectionId,
          projectId: input.projectId,
          threadId: input.threadId,
          message: input.message,
          clientRequestId: input.clientRequestId,
        }),
        signal,
      });
      return decodeSendResult(body);
    },
  };
}

/**
 * Mint one idempotency key per composed message. The key is stable across
 * retries of the SAME message (so a retry after an ambiguous acknowledgement
 * lets the native server deduplicate) and fresh for every edited message.
 */
export function mintClientRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `req-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 20)}-${hex.slice(20)}`;
}
