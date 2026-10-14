/**
 * Failures the T3 route handlers report to the browser.
 *
 * Kept pure and dependency-free so it can be unit tested without loading the
 * Clerk or Convex server runtimes. Every message here is already sanitized:
 * upstream text is discarded and replaced with a fixed, owner-facing sentence,
 * so no token, verifier, OAuth state, header or stack trace can leak through.
 */

export interface SafeFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Map an internal error onto a stable, sanitized wire failure.
 *
 * Classifications are ordered most-specific-first. Authorization and
 * configuration refusals are matched before the transport rules, so a fail-closed
 * security decision is never reported as a generic network fault.
 */
export function classifyT3Failure(error: unknown): SafeFailure {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (message === "unauthorized") {
    return { code: "access_denied", message: "Sign in with the Helm owner account to continue.", retryable: false };
  }
  if (message === "backend_unavailable") {
    return { code: "backend_unavailable", message: "The T3 connection service is unavailable.", retryable: true };
  }
  // Fail closed: the mutation was refused because this deployment's own origin
  // is not the configured one. The configured origin is never echoed back.
  if (message === "cross_origin_request") {
    return { code: "origin_mismatch", message: "This Helm deployment is not configured for its own origin, so the request was refused.", retryable: false };
  }
  if (normalized.includes("not configured")) {
    return { code: "misconfigured", message: "Helm's T3 connection service is not fully configured. An operator must finish setup.", retryable: false };
  }
  // Discovery runs against the same trusted origin, so a mismatch means the
  // endpoint does not describe itself consistently — not that it is unreachable.
  if (normalized.includes("discovery did not match") || normalized.includes("issuer did not match") ||
      normalized.includes("issuer is not trusted") || normalized.includes("endpoint is not trusted") ||
      normalized.includes("required authorization flow")) {
    return { code: "discovery_mismatch", message: "This T3 endpoint did not present matching OAuth metadata. Confirm the MCP URL copied from T3.", retryable: false };
  }
  if (message.includes("trusted HTTPS") || normalized.includes("t3 connect url") ||
      (normalized.includes("invalid") && normalized.includes("endpoint"))) {
    return { code: "invalid_endpoint", message: "Enter a supported trusted T3 Connect endpoint.", retryable: false };
  }
  if (normalized.includes("cursor") && normalized.includes("invalid")) {
    return { code: "cursor_invalid", message: "That page cursor is no longer valid. Refresh the list and try again.", retryable: false };
  }
  if (normalized.includes("revoked")) {
    return { code: "revoked", message: "T3 authorization was revoked. Reconnect to continue.", retryable: false };
  }
  if (normalized.includes("expired")) {
    return { code: "connection_expired", message: "This T3 authorization expired. Reconnect to continue.", retryable: false };
  }
  if (/t3 request failed \(429\)/u.test(normalized)) {
    return { code: "rate_limited", message: "T3 is receiving too many requests. Try again shortly.", retryable: true };
  }
  // A hostname that does not resolve may be a transient resolver failure as
  // easily as a wrong URL, so this stays retryable rather than permanent.
  if (normalized.includes("did not resolve") || normalized.includes("enotfound") ||
      normalized.includes("eai_again") || normalized.includes("getaddrinfo")) {
    return { code: "endpoint_unresolved", message: "Helm could not resolve this T3 Connect hostname. Check the URL, or try again shortly.", retryable: true };
  }
  if (normalized.includes("environment read failed")) {
    return { code: "read_failed", message: "T3 could not complete the environment read.", retryable: true };
  }
  if (normalized.includes("could not be reached") || normalized.includes("timed out") || /t3 request failed \(5\d\d\)/u.test(normalized)) {
    return { code: "unreachable", message: "The T3 endpoint could not be reached. Try again later.", retryable: true };
  }
  return { code: "unknown", message: "The T3 request could not be completed.", retryable: false };
}
