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

/**
 * The scopes T3 issues when the owner selects Full access. They are not
 * requested by Helm and must never be accepted for either access tier.
 */
export const T3_FULL_ACCESS_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "source-control:write",
] as const;

/** The exact scope string Helm requests for an access tier. */
export function requestedT3Scope(access: T3Access): string {
  return REQUESTED_SCOPES[access].join(" ");
}

/**
 * Parses an RFC 6749 scope string. Returns null for any value that is not a
 * plain, bounded, space-delimited ASCII scope string.
 */
export function parseT3Scopes(granted: unknown): readonly string[] | null {
  if (typeof granted !== "string" || granted.length === 0 || granted.length > 256) return null;
  // Forbid embedded newlines, tabs, control characters, and non-ASCII bytes.
  if (!/^[\x20-\x7e]+$/u.test(granted)) return null;
  const value = granted.trim();
  if (!value) return null;
  return value.split(/ +/u);
}

function hasExactScopeSet(tokens: readonly string[], expected: readonly string[]): boolean {
  const grantedSet = new Set(tokens);
  // Exact cardinality prevents duplicate tokens; membership prevents omissions,
  // substitutions, and additional permissions, independent of order.
  return tokens.length === expected.length &&
    grantedSet.size === expected.length &&
    expected.every((scope) => grantedSet.has(scope));
}

/** RFC 6749 scope tokens are case-sensitive and separated by spaces. */
export function hasExactT3Scopes(granted: unknown, access: T3Access): boolean {
  const tokens = parseT3Scopes(granted);
  return tokens !== null && hasExactScopeSet(tokens, REQUESTED_SCOPES[access]);
}

/**
 * Fixed, non-sensitive explanation for a rejected grant. It is derived locally
 * from the token response, but only the enum value ever leaves this module.
 */
export type T3ScopeFailureReason =
  | "operate_mode_read_only"
  | "operate_mode_full_access"
  | "unexpected_scopes";

export const T3_SCOPE_FAILURE_REASONS: readonly T3ScopeFailureReason[] = [
  "operate_mode_read_only",
  "operate_mode_full_access",
  "unexpected_scopes",
];

export function isT3ScopeFailureReason(value: unknown): value is T3ScopeFailureReason {
  return typeof value === "string" &&
    (T3_SCOPE_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * Classifies a grant that `hasExactT3Scopes` rejected. Returns null when the
 * grant is exactly what was requested.
 *
 * The two known T3 consent mistakes get a specific reason; everything else —
 * missing, duplicated, malformed, unknown or additionally broadened scopes —
 * is `unexpected_scopes`. Duplicates never match a known set, so a malformed
 * response cannot be mistaken for a legitimate Read-only or Full access grant.
 */
export function classifyT3ScopeFailure(
  granted: unknown,
  access: T3Access,
): T3ScopeFailureReason | null {
  const tokens = parseT3Scopes(granted);
  if (tokens === null) return "unexpected_scopes";
  if (hasExactScopeSet(tokens, REQUESTED_SCOPES[access])) return null;
  if (access === "operate" && hasExactScopeSet(tokens, ["orchestration:read"])) {
    return "operate_mode_read_only";
  }
  if (access === "operate" && hasExactScopeSet(tokens, T3_FULL_ACCESS_SCOPES)) {
    return "operate_mode_full_access";
  }
  return "unexpected_scopes";
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

/**
 * What the provider's `error` parameter means for the attempt.
 *
 * `denied` and `expired` are the OWNER's decision or the provider's own
 * expiry — neither is a failure of Helm, and neither is reported as one.
 * Everything else is a provider error the callback could not complete.
 */
export type T3ProviderOutcome = "denied" | "expired" | "failed";

export function classifyT3ProviderError(error: unknown): T3ProviderOutcome {
  if (error === "access_denied") return "denied";
  if (error === "consent_expired") return "expired";
  return "failed";
}

/**
 * An at-most-once reporter for ONE callback attempt.
 *
 * A single failed callback must emit exactly one sanitized diagnostic. The
 * callback can discover a failure in two places — the operation that failed,
 * and the attempt bookkeeping that follows it — so the reporter guarantees
 * the one-event contract instead of relying on control flow to stay tidy.
 */
export type T3CallbackReporter = {
  /** Emits the diagnostic unless one was already emitted. */
  report: (stage: T3CallbackStage, error?: unknown) => boolean;
  /** True once a diagnostic has been emitted. */
  readonly reported: boolean;
};

export function createT3CallbackReporter(access: T3Access): T3CallbackReporter {
  let reported = false;
  return {
    get reported() {
      return reported;
    },
    report(stage: T3CallbackStage, error?: unknown): boolean {
      if (reported) return false;
      reported = true;
      reportT3CallbackFailure(stage, access, error);
      return true;
    },
  };
}

/**
 * Records a provider-error callback and emits its single diagnostic.
 *
 * A denial and an expiry are the OWNER's decision or the provider's own
 * expiry: neither is a failure, so the attempt is recorded and NO diagnostic
 * is emitted. A provider error the owner did not cause IS a failure: the
 * attempt is recorded as failed and exactly one diagnostic is emitted.
 *
 * If recording that failure itself fails, the callback failed at
 * `attempt_finalization` — the more specific truth — so that is the
 * diagnostic, and the error is rethrown so the caller can answer with its
 * generic message. The finalisation error is never logged raw: it is passed
 * to the reporter, which extracts only an allowlisted category from it.
 */
export async function recordT3ProviderError(
  outcome: T3ProviderOutcome,
  finalize: (status: "denied" | "expired" | "failed") => Promise<void>,
  report: (stage: T3CallbackStage, error?: unknown) => void,
): Promise<void> {
  if (outcome === "denied" || outcome === "expired") {
    try {
      await finalize(outcome);
    } catch (error) {
      // The answer was not a failure, but recording it was. The callback
      // failed at the finalisation, so that is the one diagnostic.
      report("attempt_finalization", error);
      throw error;
    }
    return;
  }
  try {
    await finalize("failed");
  } catch (error) {
    report("attempt_finalization", error);
    throw error;
  }
  report("provider_response");
}
