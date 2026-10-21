import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyT3CallbackFailure,
  classifyT3ProviderError,
  createT3CallbackReporter,
  describeT3CallbackFailure,
  hasExactT3Scopes,
  recordT3ProviderError,
  reportT3CallbackFailure,
} from "./lib/t3OAuthCallbackSafety";

afterEach(() => vi.restoreAllMocks());

describe("T3 OAuth granted scopes", () => {
  it("accepts the exact read-only scope", () => {
    expect(hasExactT3Scopes("orchestration:read", "read-only")).toBe(true);
    expect(hasExactT3Scopes(" orchestration:read ", "read-only")).toBe(true);
  });

  it("accepts equivalent Operate scopes irrespective of order or spacing", () => {
    expect(hasExactT3Scopes("orchestration:read orchestration:operate", "operate")).toBe(true);
    expect(hasExactT3Scopes("orchestration:operate orchestration:read", "operate")).toBe(true);
    expect(hasExactT3Scopes("orchestration:operate  orchestration:read", "operate")).toBe(true);
  });

  it.each([
    ["missing operate", "orchestration:read", "operate"],
    ["missing read", "orchestration:operate", "operate"],
    ["extra admin", "orchestration:read orchestration:operate admin", "operate"],
    ["extra operate on read", "orchestration:read orchestration:operate", "read-only"],
    ["duplicate", "orchestration:read orchestration:read", "operate"],
    ["duplicate plus expected", "orchestration:read orchestration:operate orchestration:operate", "operate"],
    ["comma delimiter", "orchestration:read,orchestration:operate", "operate"],
    ["unknown", "orchestration:read orchestration:other", "operate"],
    ["wrong case", "orchestration:Read orchestration:operate", "operate"],
    ["newline", "orchestration:read\norchestration:operate", "operate"],
    ["tab", "orchestration:read\torchestration:operate", "operate"],
    ["empty", "", "operate"],
    ["space only", "  ", "operate"],
    ["too long", "orchestration:read ".repeat(30), "operate"],
    ["nonnumeric", undefined, "operate"],
    ["array", ["orchestration:read", "orchestration:operate"], "operate"],
  ] as const)("rejects %s", (_name, value, access) => {
    expect(hasExactT3Scopes(value, access)).toBe(false);
  });
});

describe("T3 OAuth callback diagnostics", () => {
  it("emits only safe fixed labels, not the original error or credentials", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateError = new Error("Bearer SECRET_TOKEN code=SECRET_CODE state=SECRET_STATE");
    reportT3CallbackFailure("token_exchange", "operate", privateError);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "token_exchange", category: "token_exchange_failed", access: "operate",
    });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toMatch(/SECRET_TOKEN|SECRET_CODE|SECRET_STATE|Bearer|code=/u);
  });

  it("distinguishes known upstream rejection, unavailability, and timeout without logging response bodies", () => {
    expect(classifyT3CallbackFailure("token_exchange", new Error("T3 request failed (400)")))
      .toBe("token_endpoint_rejected");
    expect(classifyT3CallbackFailure("token_exchange", new Error("T3 request failed (503)")))
      .toBe("token_endpoint_unavailable");
    expect(classifyT3CallbackFailure("token_exchange", new Error("T3 request timed out")))
      .toBe("token_exchange_timeout");
    expect(classifyT3CallbackFailure("environment_verification", new Error("T3 request failed (400)")))
      .toBe("environment_verification_failed");
  });

  it("reports the precise security decision at scope validation without exposing the granted scope", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportT3CallbackFailure("scope_validation", "operate", new Error("scope=admin SECRET"));
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "scope_validation", category: "scope_mismatch", access: "operate",
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET");
  });

  it("has a fixed diagnostic category for every callback stage", () => {
    const stages = [
      "issuer_validation", "provider_response", "pkce_decryption", "token_exchange",
      "token_validation", "scope_validation", "environment_verification",
      "token_encryption", "connection_save", "attempt_finalization",
    ] as const;
    for (const stage of stages) {
      expect(classifyT3CallbackFailure(stage)).toMatch(/^[a-z_]+$/u);
    }
  });
});

describe("T3 OAuth callback failure outcome", () => {
  it("does not claim a saved connection is unchanged", () => {
    const saved = describeT3CallbackFailure(true);
    expect(saved.connectionSaved).toBe(true);
    expect(saved.message).toMatch(/was saved/u);
    // The old wording was false in this case: the row exists and is connected.
    expect(saved.message).not.toMatch(/remains unchanged/u);
  });

  it("describes the no-save case accurately", () => {
    const notSaved = describeT3CallbackFailure(false);
    expect(notSaved.connectionSaved).toBe(false);
    expect(notSaved.message).toMatch(/could not be completed/u);
    expect(notSaved.message).toMatch(/remains unchanged/u);
  });

  it("never leaks an identifier, a scope string or upstream text", () => {
    for (const saved of [true, false]) {
      const outcome = describeT3CallbackFailure(saved);
      expect(outcome.message).not.toMatch(/https?:|token|code=|state=|orchestration:/u);
    }
  });
});

describe("T3 OAuth provider answers", () => {
  it("treats a denial and an expiry as outcomes that are not failures", () => {
    expect(classifyT3ProviderError("access_denied")).toBe("denied");
    expect(classifyT3ProviderError("consent_expired")).toBe("expired");
  });

  it("treats every other provider answer as a failure", () => {
    expect(classifyT3ProviderError("server_error")).toBe("failed");
    expect(classifyT3ProviderError("temporarily_unavailable")).toBe("failed");
    expect(classifyT3ProviderError("")).toBe("failed");
    expect(classifyT3ProviderError(undefined)).toBe("failed");
    expect(classifyT3ProviderError(new Error("Bearer SECRET"))).toBe("failed");
  });
});

describe("T3 OAuth callback reporter", () => {
  it("emits exactly one diagnostic for a single failure", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("operate");
    expect(reporter.reported).toBe(false);
    expect(reporter.report("provider_response")).toBe(true);
    expect(reporter.reported).toBe(true);
    // A second failure in the same callback must not produce a second event.
    expect(reporter.report("attempt_finalization")).toBe(false);
    expect(reporter.report("issuer_validation")).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "provider_response", category: "provider_error", access: "operate",
    });
  });

  it("never leaks credentials from the error it is given", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("read-only");
    reporter.report("token_exchange", new Error("Bearer SECRET_TOKEN code=SECRET_CODE state=SECRET_STATE"));
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/SECRET_TOKEN|SECRET_CODE|SECRET_STATE|Bearer|code=/u);
  });
});

describe("T3 OAuth provider error recording", () => {
  it("records a provider error as failed and reports the provider response once", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("operate");
    const statuses: string[] = [];
    await recordT3ProviderError(
      "failed",
      async (status) => { statuses.push(status); },
      (stage, error) => { reporter.report(stage, error); },
    );
    expect(statuses).toEqual(["failed"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "provider_response", category: "provider_error", access: "operate",
    });
  });

  it("reports the finalisation instead when the attempt cannot be recorded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("operate");
    await expect(
      recordT3ProviderError(
        "failed",
        async () => { throw new Error("owner grant is missing, revoked, or stale"); },
        (stage, error) => { reporter.report(stage, error); },
      ),
    ).rejects.toThrow(/stale/u);
    // The callback failed while recording the attempt, so that is the stage —
    // and the upstream text never reaches the log.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "attempt_finalization", category: "attempt_finalization_failed", access: "operate",
    });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/stale|revoked|grant/u);
  });

  it("records a denial and an expiry without reporting a failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("operate");
    const statuses: string[] = [];
    const finalize = async (status: "denied" | "expired" | "failed") => { statuses.push(status); };
    await recordT3ProviderError("denied", finalize, (stage, error) => { reporter.report(stage, error); });
    await recordT3ProviderError("expired", finalize, (stage, error) => { reporter.report(stage, error); });
    expect(statuses).toEqual(["denied", "expired"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports the finalisation when a denial cannot be recorded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createT3CallbackReporter("read-only");
    await expect(
      recordT3ProviderError(
        "denied",
        async () => { throw new Error("owner grant is missing, revoked, or stale"); },
        (stage, error) => { reporter.report(stage, error); },
      ),
    ).rejects.toThrow(/stale/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "attempt_finalization", category: "attempt_finalization_failed", access: "read-only",
    });
  });
});
