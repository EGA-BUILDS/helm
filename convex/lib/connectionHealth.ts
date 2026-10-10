/**
 * Connection health domain logic (EGA-679, F2 preparatory slice).
 *
 * F2 shows real Linear/T3 connection health: last check, last KNOWN success,
 * and actionable failures — while never leaking credentials. This module is
 * the domain half of that contract:
 *
 *   - `ConnectionHealth` is the persisted current-health record: status,
 *     lastSuccessAt, lastAttemptAt, sanitized lastError and a monotonically
 *     increasing checkGeneration.
 *
 *   - `LastKnownSuccess` is deliberately a SEPARATE type from current health:
 *     an older success never makes a current failure look green. Status is
 *     derived only from the LATEST attempt.
 *
 *   - `applyHealthCheck` folds a completed check into stored health and
 *     compares checkGeneration BEFORE persisting: a stale check (older or
 *     equal generation) never overwrites a newer one.
 *
 *   - `classifyConnectionError` normalizes raw failures into a closed set of
 *     kinds ("missing_config" | "unauthorized" | "transport" | "timeout" |
 *     "unknown") with a sanitized message (no tokens, no credentials embedded
 *     in URLs or env dumps) plus actionable operator guidance.
 *
 *   - `ProviderModelCatalog` carries freshness metadata (capabilityVersion,
 *     observedAt, source) and `catalogFreshness` decides staleness from an
 *     explicit `now` and a configurable threshold — deterministic, no wall
 *     clock inside the function.
 *
 * Pure functions only: no Convex imports, no network, no wall clock. All
 * inputs are explicit so tests and callers stay deterministic.
 */

/**
 * Coarse connection state persisted per connection (Linear / T3).
 *
 *   - `healthy`: the latest check succeeded — the only state that may dispatch.
 *   - `degraded`: the latest check succeeded but is suboptimal (e.g. a stale
 *     catalog), OR the endpoint answered and rejected the stored credential.
 *     A rejected credential is not a dead endpoint.
 *   - `unreachable`: the latest check could not reach the endpoint at all.
 *   - `unknown`: never checked, or the check could not run because required
 *     configuration is missing.
 */
export type ConnectionStatus = "healthy" | "degraded" | "unreachable" | "unknown";

/**
 * Normalized failure classes (EGA-679 contract, matching the EGA-677 adapter
 * vocabulary). Closed set: anything unclassifiable is "unknown", never a
 * guessed class.
 */
export type ConnectionErrorKind =
  | "missing_config"
  | "unauthorized"
  | "transport"
  | "timeout"
  | "unknown";

/**
 * A sanitized, credential-free failure safe to store and render.
 * `message` must never carry a token, a header value or an endpoint with
 * embedded credentials; `guidance` tells the operator what to do.
 */
export type ConnectionError = {
  kind: ConnectionErrorKind;
  message: string;
  guidance: string;
};

/**
 * Persisted connection health.
 *
 * `status` reflects ONLY the latest attempt: a failed check leaves the
 * connection unreachable/degraded/unknown no matter how recent
 * `lastSuccessAt` is. `lastSuccessAt` is historical information for display,
 * never a dispatch gate.
 */
export type ConnectionHealth = {
  status: ConnectionStatus;
  /** ms epoch of the last successful check, or null if there never was one. */
  lastSuccessAt: number | null;
  /** ms epoch of the last check attempt, or null if never checked. */
  lastAttemptAt: number | null;
  /** Sanitized current error, or null when the latest check succeeded. */
  lastError: ConnectionError | null;
  /**
   * Monotonically increasing check revision. Every new health check gets the
   * next generation; persisting requires a strictly greater generation than
   * the stored one.
   */
  checkGeneration: number;
};

/**
 * Last-known success, tracked separately from current health (EGA-679: "Store
 * lastSuccessAt, lastAttemptAt and sanitized current error separately").
 */
export type LastKnownSuccess = {
  /** Which connection this success belongs to, e.g. "linear" or "t3". */
  kind: string;
  /** ms epoch when the successful check happened. */
  succeededAt: number;
  /** Generation of the check that produced this success. */
  checkGeneration: number;
  /** What the successful check actually verified, e.g. "project:read". */
  capability: string;
};

/** One provider and the model identifiers it offers. */
export type ProviderModelSet = {
  id: string;
  models: string[];
};

/**
 * The supported provider/model catalog discovered from a live connection.
 * Identifiers only — never credentials, endpoints or settings.
 */
export type ProviderModelCatalog = {
  providers: ProviderModelSet[];
  /** Capability version reported by the source, e.g. a T3 capability tag. */
  capabilityVersion: string;
  /** ms epoch when the catalog was observed. */
  observedAt: number;
  /** Where the catalog was observed, e.g. "t3:orchestrator_capabilities". */
  source: string;
};

/** Sanitized, never stored raw. */
const MAX_ERROR_MESSAGE_LENGTH = 300;
const REDACTED = "[REDACTED]";

/**
 * Key fragments that mean "the value next to me is a credential". Matched
 * case-insensitively as a SUBSTRING of the surrounding key (`T3_MCP_TOKEN`,
 * `x-api-key`, `my_secret`, `AWS_SECRET_ACCESS_KEY`, `session` all match),
 * which is why the list is deliberately broad: a key we fail to recognize
 * leaks, and over-redacting a diagnostic value is the safe direction to fail.
 */
const CREDENTIAL_KEY_FRAGMENT =
  "(?:TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|AUTH|KEY|CREDENTIAL|ACCESS|SESSION|COOKIE)";

/**
 * A credential-shaped key/value assignment, in the four shapes a real failure
 * arrives in: a quoted value (JSON/object bodies — `"token": "sk-live-..."`),
 * a single-quoted value, a bracketed list, or a bare whitespace-terminated run
 * (env dumps — `T3_MCP_TOKEN=sk-live-...`).
 *
 * The bare run is greedy across commas and semicolons so a multi-part value
 * cannot leak its tail; the quoted run stops at its own closing quote so a
 * neighbouring field is never swallowed. The bare run also stops at a quote,
 * so a JSON key with an unquoted (numeric) value keeps its shape. A value that
 * already holds this function's own redaction marker, or that is itself an
 * auth-scheme word (already handled by the scheme rule), never matches.
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`([A-Za-z_]*${CREDENTIAL_KEY_FRAGMENT}[A-Za-z_]*\s*["']?\s*[:=]\s*)` +
    String.raw`(?!["']?\[REDACTED\])` +
    String.raw`(?!(?:bearer|basic|digest|negotiate|ntlm)\b)` +
    String.raw`("[^"]*"|'[^']*'|\[[^\]]*\]|[^\s"']+)`,
  "gi",
);

/**
 * Maximum catalog age before it is considered stale. Callers may pass their
 * own threshold to `catalogFreshness`; this is the default.
 */
export const DEFAULT_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Redact anything that could carry a credential:
 *   - auth-scheme header values ("Bearer <token>", "Basic <base64>", digest,
 *     negotiate, ntlm — any scheme-cased variant);
 *   - JSON Web Tokens (three base64url segments, header starting eyJ);
 *   - userinfo embedded in URLs (scheme://user:pass@host);
 *   - "token=..." style query parameters;
 *   - credential-shaped key/value pairs in BOTH shapes a real failure
 *     arrives in: env dumps ("T3_MCP_TOKEN=...", "api_key: ...",
 *     "AWS_ACCESS_KEY_ID=...", "credential=...") and object bodies
 *     ('"token": "sk-live-..."' from an MCP/JSON error response).
 *
 * There is NO minimum value length: `T3_MCP_TOKEN=abc` is redacted exactly
 * like a 64-character key, because length is not evidence of harmlessness.
 * A value is left untouched only when it is purely numeric (counts like
 * "max_tokens: 4096" are not credentials — commas/semicolons are stripped
 * before the test so "1,000" still counts) or when it already holds this
 * function's own redaction marker / an auth-scheme word; otherwise a
 * previously redacted parameter would swallow the rest of the line and a
 * second pass would not be stable.
 */
export function sanitizeForDisplay(raw: string): string {
  let out = raw;
  out = out.replace(
    /(\b(?:bearer|basic|digest|negotiate|ntlm)\s+)[A-Za-z0-9._~+/=-]+/gi,
    `$1${REDACTED}`,
  );
  out = out.replace(
    /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    REDACTED,
  );
  out = out.replace(
    /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g,
    `$1${REDACTED}@`,
  );
  out = out.replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|secret|password|session|session_id|authorization)=)[^&\s]*/gi, `$1${REDACTED}`);
  out = out.replace(CREDENTIAL_ASSIGNMENT, (match, prefix: string, value: string) => {
    // A quoted value keeps its quotes so the surrounding object stays readable.
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    // Token limits are ordinary diagnostics; credential-shaped keys (including
    // numeric values such as API_TOKEN=1234) are always redacted.
    if (/\bmax[_-]?tokens?\b/i.test(prefix)) return match;
    return quoted ? `${prefix}${quoted[1]}${REDACTED}${quoted[1]}` : `${prefix}${REDACTED}`;
  });
  return out.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function safeMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return `${raw.name}: ${raw.message}`;
  try {
    return String(raw);
  } catch {
    return "unreadable error";
  }
}

const GUIDANCE: Record<ConnectionErrorKind, string> = {
  missing_config:
    "Set the required variable in Convex environment settings. See .env.example and doc/configuration-checklist.md for the exact name.",
  unauthorized:
    "The stored credential was rejected. Reauthorize the integration through its supported flow; Helm never retries into an auth wall.",
  transport:
    "The endpoint did not answer. Verify the endpoint URL is reachable from the hosted Convex runtime (no loopback or Tailscale addresses).",
  timeout:
    "The request timed out. Retry the check later; if it persists, verify the endpoint is responsive from the hosted Convex runtime.",
  unknown:
    "An unexpected error occurred. Record the sanitized message and inspect the endpoint configuration before retrying.",
};

const SAFE_MESSAGES: Record<ConnectionErrorKind, string> = {
  missing_config: "Required integration configuration is missing.",
  unauthorized: "The configured integration credential was rejected.",
  transport: "The integration endpoint could not be reached.",
  timeout: "The integration check timed out.",
  unknown: "The integration check failed unexpectedly.",
};

/**
 * Classification order mirrors the EGA-677 hosted adapter: missing_config and
 * unauthorized first (operator-actionable), then timeout, then transport,
 * with unknown as the closed-set fallback.
 */
const KIND_PATTERNS: ReadonlyArray<{ kind: ConnectionErrorKind; pattern: RegExp }> = [
  {
    kind: "missing_config",
    pattern: /missing_config|not configured|not set|is required|missing required|must be set/i,
  },
  {
    kind: "unauthorized",
    pattern:
      /401|403|unauthorized|forbidden|invalid_mcp_credential|invalid[ _-]?api[ _-]?key|expired|revoked|authentication/i,
  },
  {
    kind: "timeout",
    pattern: /timeout|timed out|etimedout|deadline exceeded|abort/i,
  },
  {
    kind: "transport",
    pattern:
      /fetch failed|econnrefused|econnreset|econnaborted|enotfound|getaddrinfo|epipe|socket hang|connection refused|dns|network|tls|certificate/i,
  },
];

/**
 * Normalize any raw failure into a ConnectionError: a closed-set kind, a
 * sanitized message and actionable guidance.
 */
export function classifyConnectionError(raw: unknown): ConnectionError {
  const rawMessage = safeMessage(raw).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return { kind, message: SAFE_MESSAGES[kind], guidance: GUIDANCE[kind] };
    }
  }
  return { kind: "unknown", message: SAFE_MESSAGES.unknown, guidance: GUIDANCE.unknown };
}

/** Initial health: never checked, so "unknown" — never optimistically green. */
export function emptyConnectionHealth(): ConnectionHealth {
  return {
    status: "unknown",
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    checkGeneration: 0,
  };
}

/** The generation a NEW check must carry to be persisting-eligible. */
export function nextGeneration(health: ConnectionHealth | null): number {
  return (health?.checkGeneration ?? 0) + 1;
}

/** The outcome of one completed health check. */
export type HealthCheckOutcome = {
  /** Whether the check's real reads succeeded. */
  ok: boolean;
  /** ms epoch when the check ran. Explicit: no wall clock inside this module. */
  at: number;
  /**
   * Generation this check was issued under. Callers obtain it from
   * `nextGeneration` so every new check is strictly greater than the stored
   * one.
   */
  generation: number;
  /** Required when ok is false; sanitized by the classifier. */
  error?: ConnectionError;
  /**
   * Set when ok is true but something is suboptimal (e.g. "catalog_stale").
   * A degraded check still counts as a success for lastSuccessAt purposes —
   * the reads really happened.
   */
  degradation?: string;
};

export type ApplyHealthCheckResult = {
  health: ConnectionHealth;
  /** False when the check was stale and was NOT persisted. */
  persisted: boolean;
};

/**
 * Status for a FAILED check, derived from the failure kind instead of always
 * reporting "unreachable". The distinction is not cosmetic:
 *
 *   - `missing_config` never reached the endpoint at all, so "unreachable"
 *     would blame the network for a configuration gap the operator can fix in
 *     Convex env settings — "unknown" is the honest verdict.
 *   - `unauthorized` proves the endpoint ANSWERED and rejected the stored
 *     credential; that is a degraded state needing reauthorization, not a
 *     dead endpoint.
 *   - `timeout`, `transport` and `unknown` are genuinely unreachable.
 *
 * None of this can read as green: `canDispatch` stays false for every status
 * except "healthy", and a stored failure always keeps `lastError` populated.
 */
const FAILURE_STATUS: Record<ConnectionErrorKind, ConnectionStatus> = {
  missing_config: "unknown",
  unauthorized: "degraded",
  timeout: "unreachable",
  transport: "unreachable",
  unknown: "unreachable",
};

/**
 * Fold a completed check into stored health.
 *
 * Generation is compared BEFORE persisting: a stale check (generation <=
 * stored generation) never overwrites a newer one, so a slow or duplicated
 * response from an earlier check cannot regress fresh state.
 *
 * Status comes only from the LATEST attempt: a failure is never "healthy"
 * even when `lastSuccessAt` is recent — an older success is reported as
 * last-known success, it never makes the current state green. `FAILURE_STATUS`
 * only decides WHICH non-healthy label the failure gets.
 *
 * A caller-supplied `outcome.error` is re-sanitized defensively before it is
 * stored: the contract says the classifier already sanitized it, but the
 * persisted message must never depend on caller discipline.
 */
export function applyHealthCheck(
  existing: ConnectionHealth | null,
  outcome: HealthCheckOutcome,
): ApplyHealthCheckResult {
  const current = existing ?? emptyConnectionHealth();
  if (outcome.generation <= current.checkGeneration) {
    return { health: current, persisted: false };
  }
  if (!outcome.ok) {
    // The contract says outcome.error is already sanitized; re-sanitizing here
    // means the persisted message never depends on caller discipline.
    const lastError = outcome.error
      ? { ...outcome.error, message: sanitizeForDisplay(outcome.error.message) }
      : classifyConnectionError("check failed without a detail");
    return {
      health: {
        status: FAILURE_STATUS[lastError.kind],
        lastSuccessAt: current.lastSuccessAt,
        lastAttemptAt: outcome.at,
        lastError,
        checkGeneration: outcome.generation,
      },
      persisted: true,
    };
  }
  const health: ConnectionHealth = {
    status: outcome.degradation !== undefined ? "degraded" : "healthy",
    lastSuccessAt: outcome.at,
    lastAttemptAt: outcome.at,
    lastError: null,
    checkGeneration: outcome.generation,
  };
  return { health, persisted: true };
}

/**
 * Build a LastKnownSuccess record from a successful check. Kept separate
 * from current health so the UI can show "last known success" next to a
 * current failure without the two being confused.
 */
export function recordLastKnownSuccess(input: {
  kind: string;
  at: number;
  generation: number;
  capability: string;
}): LastKnownSuccess {
  return {
    kind: input.kind,
    succeededAt: input.at,
    checkGeneration: input.generation,
    capability: input.capability,
  };
}

/**
 * Display/summary view of connection health.
 *
 * `successIsHistorical` is the F2 rule made concrete: an older success exists
 * AND the latest attempt FAILED. In that case the connection shows as
 * failing (status from the latest attempt) while the older success remains
 * visible as last-known success. A latest failure must NEVER appear green
 * because an older success exists.
 *
 * "The latest attempt failed" is read from `lastError`, not from the status
 * label or from timestamps: `applyHealthCheck` stores an error exactly when
 * the attempt failed, so a failure that maps to "degraded" (a rejected
 * credential) still counts as a failure, and clock skew between two checks
 * cannot make a newer failure look older than the success it followed.
 */
export type ConnectionHealthView = {
  status: ConnectionStatus;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: ConnectionError | null;
  checkGeneration: number;
  successIsHistorical: boolean;
  /** True only when the latest check succeeded cleanly. */
  canDispatch: boolean;
};

export function summarizeConnectionHealth(health: ConnectionHealth | null): ConnectionHealthView {
  const current = health ?? emptyConnectionHealth();
  const successIsHistorical = current.lastSuccessAt !== null && current.lastError !== null;
  return {
    status: current.status,
    lastAttemptAt: current.lastAttemptAt,
    lastSuccessAt: current.lastSuccessAt,
    lastError: current.lastError,
    checkGeneration: current.checkGeneration,
    successIsHistorical,
    canDispatch: current.status === "healthy",
  };
}

/**
 * True when the latest attempt failed while an older success exists — the
 * exact case F2 must display as a current failure with a historical success,
 * never as green.
 */
export function currentFailureWithHistoricalSuccess(health: ConnectionHealth | null): boolean {
  return summarizeConnectionHealth(health).successIsHistorical;
}

export type CatalogFreshness = {
  stale: boolean;
  /** now - observedAt; negative when observedAt is in the future. */
  ageMs: number;
  maxAgeMs: number;
}

/**
 * Decide catalog freshness from an explicit `now` and a configurable
 * threshold. Deterministic: no wall clock, no randomness. A catalog observed
 * in the future (clock skew) is simply not stale.
 */
export function catalogFreshness(
  catalog: { observedAt: number },
  now: number,
  maxAgeMs: number = DEFAULT_CATALOG_MAX_AGE_MS,
): CatalogFreshness {
  const ageMs = now - catalog.observedAt;
  return { stale: ageMs > maxAgeMs, ageMs, maxAgeMs };
}

export type CatalogValidation =
  | { ok: true; catalog: ProviderModelCatalog }
  | { ok: false; issues: string[] };

/**
 * Validate a discovered catalog before it is persisted. Fail closed: a
 * catalog with no providers, an empty capability version or a non-positive
 * observedAt is rejected rather than stored as if it were evidence.
 *
 * Values are validated after trimming and the TRIMMED values are what gets
 * returned, so a padded-but-valid catalog is stored in canonical form and
 * later comparisons never disagree over whitespace.
 */
export function validateCatalog(input: unknown): CatalogValidation {
  const issues: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["catalog is missing or is not an object"] };
  }
  const record = input as Record<string, unknown>;

  if (!Array.isArray(record.providers) || record.providers.length === 0) {
    issues.push("catalog providers must be a non-empty array");
  } else {
    (record.providers as unknown[]).forEach((provider, index) => {
      if (typeof provider !== "object" || provider === null) {
        issues.push(`provider at index ${index} is not an object`);
        return;
      }
      const p = provider as Record<string, unknown>;
      if (typeof p.id !== "string" || p.id.trim() === "") {
        issues.push(`provider at index ${index} has an empty id`);
      }
      if (!Array.isArray(p.models) || p.models.length === 0) {
        issues.push(`provider "${String(p.id ?? index)}" has no models`);
      } else {
        (p.models as unknown[]).forEach((model, modelIndex) => {
          if (typeof model !== "string" || model.trim() === "") {
            issues.push(`provider "${String(p.id ?? index)}" model at index ${modelIndex} is empty`);
          }
        });
      }
    });
  }

  if (typeof record.capabilityVersion !== "string" || record.capabilityVersion.trim() === "") {
    issues.push("capabilityVersion is empty");
  }
  if (typeof record.observedAt !== "number" || !Number.isFinite(record.observedAt) || record.observedAt <= 0) {
    issues.push("observedAt must be a positive number (ms epoch)");
  }
  if (typeof record.source !== "string" || record.source.trim() === "") {
    issues.push("source is empty");
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    catalog: {
      providers: (record.providers as ProviderModelSet[]).map((p) => ({
        id: p.id.trim(),
        models: p.models.map((model) => model.trim()),
      })),
      capabilityVersion: (record.capabilityVersion as string).trim(),
      observedAt: record.observedAt as number,
      source: (record.source as string).trim(),
    },
  };
}
