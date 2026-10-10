import { describe, expect, it } from "vitest";
import {
  applyHealthCheck,
  catalogFreshness,
  classifyConnectionError,
  currentFailureWithHistoricalSuccess,
  DEFAULT_CATALOG_MAX_AGE_MS,
  emptyConnectionHealth,
  nextGeneration,
  recordLastKnownSuccess,
  sanitizeForDisplay,
  summarizeConnectionHealth,
  validateCatalog,
} from "./connectionHealth";

/**
 * EGA-679 F2 preparatory slice: connection health domain logic.
 *
 * All fixtures use synthetic ids, timestamps and errors. No real endpoint,
 * credential or deployment appears here, and every timestamp is explicit so
 * the tests are deterministic.
 */
describe("sanitizeForDisplay", () => {
  it("redacts bearer credentials", () => {
    const out = sanitizeForDisplay(
      'request failed: Authorization: Bearer sk-live-abcdef1234567890abcdef',
    );
    expect(out).not.toContain("sk-live-abcdef1234567890abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts JSON web tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    const out = sanitizeForDisplay(`token in body: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts credentials embedded in URLs", () => {
    const out = sanitizeForDisplay("failed to reach https://user:secret123@example.com/mcp");
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("user:secret123");
    expect(out).toContain("[REDACTED]@");
    expect(out).toContain("example.com");
  });

  it("redacts credential query parameters", () => {
    const out = sanitizeForDisplay("GET https://example.com/mcp?token=abc123def456&limit=10");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain("limit=10");
    expect(out).toContain("token=[REDACTED]");
  });

  it("redacts env-dump style leaks but leaves short numeric counts alone", () => {
    const leaked = sanitizeForDisplay("config: T3_MCP_TOKEN=abcdef123456 LINEAR_API_KEY=deadbeefcafe");
    expect(leaked).not.toContain("abcdef123456");
    expect(leaked).not.toContain("deadbeefcafe");
    const harmless = sanitizeForDisplay("settings: max_tokens: 4096");
    expect(harmless).toBe("settings: max_tokens: 4096");
  });

  it("redacts basic-auth credentials, not just bearer", () => {
    const out = sanitizeForDisplay("authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    // The scheme word survives (it is not a credential); the base64 value does not.
    expect(out).toBe("authorization: Basic [REDACTED]");
  });

  it("redacts env-dump keys beyond the original list (KEY, CREDENTIAL, ACCESS)", () => {
    const out = sanitizeForDisplay(
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE credential=supersecretvalue123",
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("supersecretvalue123");
  });

  it("redacts short credential values (no 8-character minimum)", () => {
    const out = sanitizeForDisplay("T3_MCP_TOKEN=abc123");
    expect(out).not.toContain("abc123");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts multi-part values greedily across commas (no partial leak)", () => {
    const out = sanitizeForDisplay("TOKEN=abcdefghijkl,mnop12345");
    expect(out).toBe("TOKEN=[REDACTED]");
    expect(out).not.toContain("mnop12345");
  });

  it("redacts credentials in JSON/object bodies, not just env dumps", () => {
    const out = sanitizeForDisplay(
      'MCP error {"code":-32001,"message":"invalid_mcp_credential","token":"sk-live-987654321"}',
    );
    expect(out).not.toContain("sk-live-987654321");
    expect(out).toContain("invalid_mcp_credential");
    expect(out).toContain('"token":"[REDACTED]"');
  });

  it("redacts session and cookie carriers", () => {
    for (const raw of [
      "Cookie: session=abc123def456",
      'Set-Cookie: sid=abc123def456; Path=/',
      '{"session_id":"sess_abc123def456"}',
    ]) {
      expect(sanitizeForDisplay(raw)).not.toContain("abc123def456");
    }
  });

  it("leaves numeric JSON values alone, including quoted ones", () => {
    for (const raw of [
      '{"max_tokens":4096,"retries":3}',
      '{"max_tokens":"4096"}',
      "settings: max_tokens: 4096",
    ]) {
      expect(sanitizeForDisplay(raw)).toBe(raw);
    }
  });

  it("redacts numeric credentials under credential-shaped keys while preserving limits", () => {
    for (const raw of ['{"api_key":12345}', '{"access_token":987}', "API_TOKEN=12345", "max_tokens: 4096"]) {
      const out = sanitizeForDisplay(raw);
      if (raw.startsWith("max_tokens")) expect(out).toBe(raw);
      else expect(out).toContain("[REDACTED]");
    }
  });

  it("is stable when sanitized twice (a second pass cannot eat the line)", () => {
    for (const raw of [
      "T3_MCP_TOKEN=abc123",
      'Authorization: Bearer sk-live-abcdef1234567890',
      '{"token":"sk-live-987654321","user":"ops"}',
      "T3_MCP_TOKEN=[REDACTED]",
    ]) {
      const once = sanitizeForDisplay(raw);
      expect(sanitizeForDisplay(once)).toBe(once);
    }
  });

  it("truncates long messages", () => {
    const out = sanitizeForDisplay("x".repeat(1000));
    expect(out).toHaveLength(300);
  });

  it("leaves ordinary diagnostic text untouched", () => {
    const out = sanitizeForDisplay("connection refused by endpoint");
    expect(out).toBe("connection refused by endpoint");
  });
});

describe("classifyConnectionError", () => {
  it("classifies missing configuration", () => {
    const err = classifyConnectionError("T3_MCP_TOKEN is not set in the deployment environment");
    expect(err.kind).toBe("missing_config");
    expect(err.guidance.length).toBeGreaterThan(0);
  });

  it("returns fixed safe messages rather than upstream diagnostics", () => {
    const secret = "synthetic-short-secret";
    const result = classifyConnectionError(new Error(`401 bearer ${secret} api_key=${secret}`));
    expect(result.kind).toBe("unauthorized");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message).toBe("The configured integration credential was rejected.");
  });

  it("classifies authorization failures, including the EGA-677 invalid_mcp_credential tag", () => {
    for (const raw of [
      "invalid_mcp_credential",
      "Request failed with status 401",
      "403 Forbidden",
      "Linear authentication failed: expired token",
    ]) {
      expect(classifyConnectionError(raw).kind).toBe("unauthorized");
    }
  });

  it("classifies timeouts distinctly from transport", () => {
    expect(classifyConnectionError("ConnectTimeoutError: connection timed out").kind).toBe("timeout");
    expect(classifyConnectionError("AbortError: signal timed out").kind).toBe("timeout");
  });

  it("classifies transport failures", () => {
    for (const raw of [
      "fetch failed",
      "connect ECONNREFUSED 127.0.0.1:443",
      "getaddrinfo ENOTFOUND example.com",
      "network error",
    ]) {
      expect(classifyConnectionError(raw).kind).toBe("transport");
    }
  });

  it("falls back to unknown for unrecognized failures", () => {
    const err = classifyConnectionError("something entirely unexpected happened");
    expect(err.kind).toBe("unknown");
    expect(err.guidance.length).toBeGreaterThan(0);
  });

  it("returns a sanitized message: raw input with a token never survives", () => {
    const err = classifyConnectionError(
      "401 from https://example.com/mcp?token=abcdef123456 (Bearer zzz)",
    );
    expect(err.message).not.toContain("abcdef123456");
    expect(err.message).not.toContain("zzz");
    expect(err.kind).toBe("unauthorized");
  });

  it("handles Error objects and non-string input", () => {
    expect(classifyConnectionError(new Error("401 Unauthorized")).kind).toBe("unauthorized");
    expect(classifyConnectionError({ weird: true }).kind).toBe("unknown");
  });
});

describe("applyHealthCheck", () => {
  const at = 1_700_000_000_000;

  it("starts unknown and never optimistically green", () => {
    expect(emptyConnectionHealth()).toEqual({
      status: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      checkGeneration: 0,
    });
  });

  it("persists a successful first check as healthy", () => {
    const result = applyHealthCheck(null, { ok: true, at, generation: 1 });
    expect(result.persisted).toBe(true);
    expect(result.health).toEqual({
      status: "healthy",
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastError: null,
      checkGeneration: 1,
    });
  });

  it("persists a successful check with a degradation warning as degraded", () => {
    const result = applyHealthCheck(null, {
      ok: true,
      at,
      generation: 1,
      degradation: "catalog_stale",
    });
    expect(result.persisted).toBe(true);
    expect(result.health.status).toBe("degraded");
    expect(result.health.lastSuccessAt).toBe(at);
  });

  it("a failed check records the error and keeps the historical success", () => {
    const first = applyHealthCheck(null, { ok: true, at, generation: 1 });
    const second = applyHealthCheck(first.health, {
      ok: false,
      at: at + 1000,
      generation: 2,
      error: classifyConnectionError("fetch failed"),
    });
    expect(second.persisted).toBe(true);
    expect(second.health.status).toBe("unreachable");
    expect(second.health.lastSuccessAt).toBe(at);
    expect(second.health.lastAttemptAt).toBe(at + 1000);
    expect(second.health.lastError?.kind).toBe("transport");
  });

  it("a stale check never overwrites a newer one", () => {
    const first = applyHealthCheck(null, { ok: false, at, generation: 5 });
    expect(first.health.status).toBe("unreachable");
    const stale = applyHealthCheck(first.health, {
      ok: true,
      at: at + 50,
      generation: 3,
    });
    expect(stale.persisted).toBe(false);
    expect(stale.health).toBe(first.health);
    expect(stale.health.status).toBe("unreachable");
    expect(stale.health.checkGeneration).toBe(5);
  });

  it("an equal generation is treated as stale (only strictly newer persists)", () => {
    const first = applyHealthCheck(null, { ok: true, at, generation: 2 });
    const redelivery = applyHealthCheck(first.health, { ok: true, at: at + 10, generation: 2 });
    expect(redelivery.persisted).toBe(false);
    expect(redelivery.health.lastAttemptAt).toBe(at);
  });

  it("a newer generation always persists, even when it regresses to failing", () => {
    const healthy = applyHealthCheck(null, { ok: true, at, generation: 1 });
    const failing = applyHealthCheck(healthy.health, {
      ok: false,
      at: at + 10,
      generation: 2,
      error: classifyConnectionError("invalid_mcp_credential"),
    });
    expect(failing.persisted).toBe(true);
    // An auth failure is a rejected credential, not a dead endpoint.
    expect(failing.health.status).toBe("degraded");
    expect(failing.health.lastError?.kind).toBe("unauthorized");
    expect(failing.health.checkGeneration).toBe(2);
  });

  it("a transport or timeout failure stays unreachable", () => {
    for (const raw of ["fetch failed", "connection timed out", "something entirely unexpected"]) {
      const result = applyHealthCheck(null, {
        ok: false,
        at,
        generation: 1,
        error: classifyConnectionError(raw),
      });
      expect(result.health.status).toBe("unreachable");
      expect(currentFailureWithHistoricalSuccess(result.health)).toBe(false);
    }
  });

  it("a missing-config failure is unknown, not unreachable: the endpoint was never probed", () => {
    const result = applyHealthCheck(null, {
      ok: false,
      at,
      generation: 1,
      error: classifyConnectionError("T3_MCP_TOKEN is not set in the deployment environment"),
    });
    expect(result.health.lastError?.kind).toBe("missing_config");
    expect(result.health.status).toBe("unknown");
    // Still not dispatchable: a failure never reads as green.
    expect(summarizeConnectionHealth(result.health).canDispatch).toBe(false);
  });

  it("classifies a raw error when the outcome omits one", () => {
    const result = applyHealthCheck(null, { ok: false, at, generation: 1 });
    // outcome.error is optional; the classifier provides the sanitized failure.
    expect(result.health.lastError?.kind).toBe("unknown");
  });

  it("re-sanitizes a caller-supplied error message before storing it", () => {
    // The contract says the classifier already sanitized outcome.error, but
    // the persisted message must never depend on caller discipline.
    const result = applyHealthCheck(null, {
      ok: false,
      at,
      generation: 1,
      error: {
        kind: "transport",
        message: "fetch failed: token=abcdef123456",
        guidance: "operator guidance",
      },
    });
    expect(result.health.lastError?.message).not.toContain("abcdef123456");
    expect(result.health.lastError?.kind).toBe("transport");
  });
});

describe("generation helpers", () => {
  it("nextGeneration is monotonically increasing from null", () => {
    expect(nextGeneration(null)).toBe(1);
    const g1 = applyHealthCheck(null, { ok: true, at: 0, generation: 1 }).health;
    expect(nextGeneration(g1)).toBe(2);
    const g5 = applyHealthCheck(g1, { ok: true, at: 0, generation: 5 }).health;
    expect(nextGeneration(g5)).toBe(6);
  });
});

describe("last known success vs current failure", () => {
  const at = 1_700_000_000_000;

  it("distinguishes a current failure from a historical success", () => {
    const healthy = applyHealthCheck(null, { ok: true, at, generation: 1 });
    const failed = applyHealthCheck(healthy.health, {
      ok: false,
      at: at + 5000,
      generation: 2,
      error: classifyConnectionError("fetch failed"),
    }).health;
    const view = summarizeConnectionHealth(failed);
    expect(view.status).toBe("unreachable");
    expect(view.lastSuccessAt).toBe(at);
    expect(view.successIsHistorical).toBe(true);
    expect(view.canDispatch).toBe(false);
    expect(currentFailureWithHistoricalSuccess(failed)).toBe(true);
  });

  it("a latest success is not historical", () => {
    const result = applyHealthCheck(null, { ok: true, at, generation: 1 }).health;
    expect(summarizeConnectionHealth(result).successIsHistorical).toBe(false);
    expect(currentFailureWithHistoricalSuccess(result)).toBe(false);
  });

  it("never checked has no historical success and cannot dispatch", () => {
    const view = summarizeConnectionHealth(null);
    expect(view.status).toBe("unknown");
    expect(view.successIsHistorical).toBe(false);
    expect(view.canDispatch).toBe(false);
  });

  it("a degraded check still counts as the latest success", () => {
    const degraded = applyHealthCheck(null, {
      ok: true,
      at,
      generation: 1,
      degradation: "catalog_stale",
    }).health;
    const view = summarizeConnectionHealth(degraded);
    expect(view.status).toBe("degraded");
    expect(view.successIsHistorical).toBe(false);
    expect(view.canDispatch).toBe(false);
  });

  it("a failure that maps to degraded still has a historical success", () => {
    // An auth failure persists as "degraded" (endpoint answered, credential
    // rejected). That must not be mistaken for the soft-degradation success,
    // or an older success would stop reading as historical.
    const healthy = applyHealthCheck(null, { ok: true, at, generation: 1 });
    const failed = applyHealthCheck(healthy.health, {
      ok: false,
      at: at + 5000,
      generation: 2,
      error: classifyConnectionError("invalid_mcp_credential"),
    }).health;
    const view = summarizeConnectionHealth(failed);
    expect(view.status).toBe("degraded");
    expect(view.successIsHistorical).toBe(true);
    expect(view.canDispatch).toBe(false);
  });

  it("treats the success as historical even when timestamps go backwards", () => {
    // A newer generation with an EARLIER `at` (clock skew) must not fool the
    // heuristic: the generation guard makes the failed attempt the newest
    // check, so the recorded success is historical regardless of timestamps.
    const healthy = applyHealthCheck(null, { ok: true, at: at + 1000, generation: 1 });
    const failed = applyHealthCheck(healthy.health, {
      ok: false,
      at,
      generation: 2,
      error: classifyConnectionError("fetch failed"),
    }).health;
    expect(failed.lastAttemptAt).toBe(at);
    expect(failed.lastSuccessAt).toBe(at + 1000);
    const view = summarizeConnectionHealth(failed);
    expect(view.successIsHistorical).toBe(true);
    expect(currentFailureWithHistoricalSuccess(failed)).toBe(true);
  });

  it("builds a separate LastKnownSuccess record", () => {
    const record = recordLastKnownSuccess({
      kind: "t3",
      at,
      generation: 3,
      capability: "project:read",
    });
    expect(record).toEqual({
      kind: "t3",
      succeededAt: at,
      checkGeneration: 3,
      capability: "project:read",
    });
  });
});

describe("provider model catalog freshness", () => {
  const now = 1_700_000_000_000;

  it("a fresh catalog is not stale", () => {
    const result = catalogFreshness({ observedAt: now - 60_000 }, now);
    expect(result.stale).toBe(false);
    expect(result.ageMs).toBe(60_000);
  });

  it("a catalog older than the threshold is stale", () => {
    const result = catalogFreshness(
      { observedAt: now - DEFAULT_CATALOG_MAX_AGE_MS - 1 },
      now,
    );
    expect(result.stale).toBe(true);
    expect(result.maxAgeMs).toBe(DEFAULT_CATALOG_MAX_AGE_MS);
  });

  it("honours a configurable threshold", () => {
    const result = catalogFreshness({ observedAt: now - 10 * 60_000 }, now, 5 * 60_000);
    expect(result.stale).toBe(true);
    const fresh = catalogFreshness({ observedAt: now - 60_000 }, now, 5 * 60_000);
    expect(fresh.stale).toBe(false);
  });

  it("is deterministic: same inputs, same verdict; a future observation is not stale", () => {
    expect(catalogFreshness({ observedAt: now - 1000 }, now)).toEqual(
      catalogFreshness({ observedAt: now - 1000 }, now),
    );
    expect(catalogFreshness({ observedAt: now + 60_000 }, now).stale).toBe(false);
  });
});

describe("validateCatalog", () => {
  const valid = {
    providers: [{ id: "test-provider", models: ["test-provider/model-a", "test-provider/model-b"] }],
    capabilityVersion: "test-capabilities-v1",
    observedAt: 1_700_000_000_000,
    source: "test:orchestrator_capabilities",
  };

  it("accepts a well-formed catalog and copies it", () => {
    const result = validateCatalog(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog).toEqual(valid);
    }
  });

  it("rejects a catalog with no providers", () => {
    const result = validateCatalog({ ...valid, providers: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("providers");
    }
  });

  it("rejects an empty capability version", () => {
    const result = validateCatalog({ ...valid, capabilityVersion: "  " });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive observedAt", () => {
    for (const observedAt of [0, -1, Number.NaN]) {
      const result = validateCatalog({ ...valid, observedAt });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a provider with an empty model id", () => {
    const result = validateCatalog({
      ...valid,
      providers: [{ id: "test-provider", models: [""] }],
    });
    expect(result.ok).toBe(false);
  });

  it("stores trimmed values, not the raw padded input", () => {
    const result = validateCatalog({
      ...valid,
      providers: [{ id: "  test-provider  ", models: ["  test-provider/model-a  "] }],
      capabilityVersion: "  test-capabilities-v1  ",
      source: "  test:orchestrator_capabilities  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.providers[0].id).toBe("test-provider");
      expect(result.catalog.providers[0].models).toEqual(["test-provider/model-a"]);
      expect(result.catalog.capabilityVersion).toBe("test-capabilities-v1");
      expect(result.catalog.source).toBe("test:orchestrator_capabilities");
    }
  });

  it("collects all issues at once", () => {
    const result = validateCatalog({ providers: [], capabilityVersion: "", observedAt: 0, source: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("end-to-end: health sequence with generations", () => {
  const at = 1_700_000_000_000;

  // One scenario in one test: no `let` shared between `it` blocks, so block
  // order and re-runs cannot leak state from one step into the next.
  it("walks unknown -> healthy -> stale redelivery -> failing -> recovered", () => {
    let health = applyHealthCheck(null, { ok: true, at, generation: nextGeneration(null) }).health;
    expect(summarizeConnectionHealth(health).status).toBe("healthy");

    // Out-of-order redelivery of an old check must not regress state.
    const redelivered = applyHealthCheck(health, { ok: false, at: at - 5000, generation: 1 });
    expect(redelivered.persisted).toBe(false);
    expect(summarizeConnectionHealth(health).status).toBe("healthy");

    health = applyHealthCheck(health, {
      ok: false,
      at: at + 60_000,
      generation: nextGeneration(health),
      error: classifyConnectionError("invalid_mcp_credential"),
    }).health;
    const view = summarizeConnectionHealth(health);
    expect(view.status).toBe("degraded");
    expect(view.lastError?.kind).toBe("unauthorized");
    expect(view.successIsHistorical).toBe(true);
    expect(view.canDispatch).toBe(false);

    // A missing-config failure is reported as unknown, never as unreachable.
    health = applyHealthCheck(health, {
      ok: false,
      at: at + 90_000,
      generation: nextGeneration(health),
      error: classifyConnectionError("T3_MCP_TOKEN is not set in the deployment environment"),
    }).health;
    expect(summarizeConnectionHealth(health).status).toBe("unknown");

    // A newer successful check recovers.
    health = applyHealthCheck(health, {
      ok: true,
      at: at + 120_000,
      generation: nextGeneration(health),
    }).health;
    expect(summarizeConnectionHealth(health).status).toBe("healthy");
    expect(summarizeConnectionHealth(health).canDispatch).toBe(true);
  });
});
