/**
 * Fail-closed scope comparison and redacted callback diagnostics for T3 OAuth.
 * No token, code, state, verifier, URL, remote error text, or exception object
 * is ever sent to a log or returned to a client by this module.
 */
export type T3Access = "read-only" | "operate";
export type T3CallbackStage =
  | "issuer_validation"
  | "provider_response"
  | "pkce_decryption"
  | "token_exchange"
  | "token_validation"
  | "scope_validation"
  | "environment_verification"
  | "token_encryption"
  | "connection_save"
  | "attempt_finalization";

const REQUESTED_SCOPES: Record<T3Access, readonly string[]> = {
  "read-only": ["orchestration:read"],
  operate: ["orchestration:read", "orchestration:operate"],
};

/** RFC 6749 scope tokens are case-sensitive and separated by spaces. */
export function hasExactT3Scopes(granted: unknown, access: T3Access): boolean {
  if (typeof granted !== "string" || granted.length === 0 || granted.length > 256) return false;
  // Forbid embedded newlines, tabs, control characters, and non-ASCII bytes.
  if (!/^[\x20-\x7e]+$/u.test(granted)) return false;
  const value = granted.trim();
  if (!value) return false;
  const tokens = value.split(/ +/u);
  const expected = REQUESTED_SCOPES[access];
  const grantedSet = new Set(tokens);
  // Exact cardinality prevents duplicate tokens; membership prevents omissions,
  // substitutions, and additional permissions, independent of order.
  return tokens.length === expected.length &&
    grantedSet.size === expected.length &&
    expected.every((scope) => grantedSet.has(scope));
}

export type T3CallbackFailureCategory =
  | "issuer_mismatch"
  | "provider_error"
  | "pkce_decrypt_failed"
  | "token_exchange_failed"
  | "token_endpoint_rejected"
  | "token_endpoint_unavailable"
  | "token_exchange_timeout"
  | "token_response_invalid"
  | "scope_mismatch"
  | "environment_verification_failed"
  | "token_encrypt_failed"
  | "connection_save_failed"
  | "attempt_finalization_failed";

/**
 * Never include the original exception text. Only a fixed allowlisted
 * token-endpoint HTTP status class or timeout is extracted from an error.
 */
export function classifyT3CallbackFailure(
  stage: T3CallbackStage,
  error?: unknown,
): T3CallbackFailureCategory {
  if (stage === "token_exchange" && error instanceof Error) {
    if (/^T3 request failed \(4\d\d\)$/u.test(error.message)) return "token_endpoint_rejected";
    if (/^T3 request failed \(5\d\d\)$/u.test(error.message)) return "token_endpoint_unavailable";
    if (error.message === "T3 request timed out") return "token_exchange_timeout";
  }
  const byStage: Record<T3CallbackStage, T3CallbackFailureCategory> = {
    issuer_validation: "issuer_mismatch",
    provider_response: "provider_error",
    pkce_decryption: "pkce_decrypt_failed",
    token_exchange: "token_exchange_failed",
    token_validation: "token_response_invalid",
    scope_validation: "scope_mismatch",
    environment_verification: "environment_verification_failed",
    token_encryption: "token_encrypt_failed",
    connection_save: "connection_save_failed",
    attempt_finalization: "attempt_finalization_failed",
  };
  return byStage[stage];
}

export function reportT3CallbackFailure(
  stage: T3CallbackStage,
  access: T3Access,
  error?: unknown,
): void {
  console.error("t3_oauth_callback_failure", {
    stage,
    category: classifyT3CallbackFailure(stage, error),
    access,
  });
}

/**
 * The exact external outcome of a failed callback.
 *
 * `connectionSaved` is true when the connection row was already written before
 * the failure. The two cases must NOT share a message: after a successful save
 * the connection EXISTS and is connected, so describing it as "unchanged" would
 * be false and would send the owner looking for a change that had already
 * happened. The wording carries no secret and no upstream text.
 */
export type T3CallbackFailureOutcome = {
  /** True when a connection row was written before the failure. */
  readonly connectionSaved: boolean;
  /** The exact message the owner sees. */
  readonly message: string;
};

export function describeT3CallbackFailure(connectionSaved: boolean): T3CallbackFailureOutcome {
  if (connectionSaved) {
    return {
      connectionSaved: true,
      message: "T3 connection was saved but its attempt could not be finalised; the connection is listed and may require re-authorization",
    };
  }
  return {
    connectionSaved: false,
    message: "T3 connection could not be completed; existing connection remains unchanged",
  };
}
