/**
 * Failures the T3 and Linear route handlers report to the browser.
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
 * Provider-specific copy and transport patterns for the shared classifier.
 *
 * Each provider names itself in its own messages (`label`) and matches its
 * own wire errors (`rateLimitedPattern` / `serverErrorPattern`, tested against
 * the lowercased message). Branches whose match conditions are provider-worded
 * upstream errors (OAuth discovery, endpoint policy, page cursors, environment
 * reads) only fire for those inputs; they keep their original copy verbatim.
 */
export interface FailureProvider {
  label: string;
  rateLimitedPattern: RegExp;
  serverErrorPattern: RegExp;
  unresolvableNoun: string;
}

const T3_PROVIDER: FailureProvider = {
  label: "T3",
  rateLimitedPattern: /t3 request failed \(429\)/u,
  serverErrorPattern: /t3 request failed \(5\d\d\)/u,
  unresolvableNoun: "this T3 Connect hostname",
};

const LINEAR_PROVIDER: FailureProvider = {
  label: "Linear",
  rateLimitedPattern: /linear request failed \(429\)/u,
  serverErrorPattern: /linear request failed \(5\d\d\)/u,
  unresolvableNoun: "the Linear hostname",
};

/**
 * Map an internal error onto a stable, sanitized wire failure.
 *
 * Classifications are ordered most-specific-first. Authorization and
 * configuration refusals are matched before the transport rules, so a fail-closed
 * security decision is never reported as a generic network fault.
 */
export function classifyFailure(error: unknown, provider: FailureProvider): SafeFailure {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (message === "unauthorized") {
    return { code: "access_denied", message: "Sign in with the Helm owner account to continue.", retryable: false };
  }
  if (message === "backend_unavailable") {
    return { code: "backend_unavailable", message: `The ${provider.label} connection service is unavailable.`, retryable: true };
  }
  // Fail closed: the mutation was refused because this deployment's own origin
  // is not the configured one. The configured origin is never echoed back.
  if (message === "cross_origin_request") {
    return { code: "origin_mismatch", message: "This Helm deployment is not configured for its own origin, so the request was refused.", retryable: false };
  }
  if (normalized.includes("not configured")) {
    return { code: "misconfigured", message: `Helm's ${provider.label} connection service is not fully configured. An operator must finish setup.`, retryable: false };
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
    return { code: "revoked", message: `${provider.label} authorization was revoked. Reconnect to continue.`, retryable: false };
  }
  if (normalized.includes("expired")) {
    return { code: "connection_expired", message: `This ${provider.label} authorization expired. Reconnect to continue.`, retryable: false };
  }
  if (provider.rateLimitedPattern.test(normalized)) {
    return { code: "rate_limited", message: `${provider.label} is receiving too many requests. Try again shortly.`, retryable: true };
  }
  // A hostname that does not resolve may be a transient resolver failure as
  // easily as a wrong URL, so this stays retryable rather than permanent.
  if (normalized.includes("did not resolve") || normalized.includes("enotfound") ||
      normalized.includes("eai_again") || normalized.includes("getaddrinfo")) {
    return { code: "endpoint_unresolved", message: `Helm could not resolve ${provider.unresolvableNoun}. Check the URL, or try again shortly.`, retryable: true };
  }
  if (normalized.includes("environment read failed")) {
    return { code: "read_failed", message: "T3 could not complete the environment read.", retryable: true };
  }
  if (normalized.includes("could not be reached") || normalized.includes("timed out") || provider.serverErrorPattern.test(normalized)) {
    return { code: "unreachable", message: `The ${provider.label} endpoint could not be reached. Try again later.`, retryable: true };
  }
  return { code: "unknown", message: `The ${provider.label} request could not be completed.`, retryable: false };
}

/**
 * T3 route classifier. A thin wrapper over the shared core with the T3 label
 * and T3 transport patterns; its observable output is unchanged.
 */
export function classifyT3Failure(error: unknown): SafeFailure {
  return classifyFailure(error, T3_PROVIDER);
}

/**
 * Linear route classifier. Same table as T3, with Linear copy and
 * `Linear request failed (...)` transport patterns.
 */
export function classifyLinearFailure(error: unknown): SafeFailure {
  return classifyFailure(error, LINEAR_PROVIDER);
}
