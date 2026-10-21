import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyT3CallbackFailure,
  describeT3CallbackFailure,
  hasExactT3Scopes,
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
