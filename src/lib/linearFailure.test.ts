import { describe, expect, it } from "vitest";
import { classifyLinearFailure, classifyT3Failure } from "./t3Failure";
import { linearStatus } from "./linearBackend";

const err = (message: string) => new Error(message);

/**
 * Linear failure classification (EGA-759 repair).
 *
 * The shared table is provider-aware: Linear wire errors (`Linear request
 * failed (...)`) classify like their T3 counterparts, and every owner-facing
 * sentence names Linear, never T3. T3 output itself is pinned by
 * `t3Failure.test.ts`, which must keep passing untouched.
 */
describe("Linear failure classification", () => {
  it("classifies a Linear 429 as retryable rate limiting", () => {
    expect(classifyLinearFailure(err("Linear request failed (429)"))).toEqual({
      code: "rate_limited",
      message: "Linear is receiving too many requests. Try again shortly.",
      retryable: true,
    });
  });

  it("classifies a Linear 5xx as a retryable unreachable endpoint", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyLinearFailure(err(`Linear request failed (${status})`)), `status ${status}`).toEqual({
        code: "unreachable",
        message: "The Linear endpoint could not be reached. Try again later.",
        retryable: true,
      });
    }
    expect(classifyLinearFailure(err("Linear request timed out"))).toMatchObject({ code: "unreachable", retryable: true });
    expect(classifyLinearFailure(err("Linear workspace could not be reached"))).toMatchObject({ code: "unreachable", retryable: true });
  });

  it("reports missing Linear configuration without naming the setting", () => {
    const result = classifyLinearFailure(err("Linear OAuth is not configured"));
    expect(result.code).toBe("misconfigured");
    expect(result.retryable).toBe(false);
    expect(result.message).toBe("Helm's Linear connection service is not fully configured. An operator must finish setup.");
    expect(result.message).not.toMatch(/client|key/i);
  });

  it("names Linear, not T3, in revoked and expired authorization copy", () => {
    expect(classifyLinearFailure(err("Linear authorization was revoked; reconnect to continue"))).toEqual({
      code: "revoked",
      message: "Linear authorization was revoked. Reconnect to continue.",
      retryable: false,
    });
    expect(classifyLinearFailure(err("Linear connection has expired; reconnect it to continue"))).toEqual({
      code: "connection_expired",
      message: "This Linear authorization expired. Reconnect to continue.",
      retryable: false,
    });
  });

  it("never emits T3 copy for Linear inputs", () => {
    for (const message of [
      "Linear OAuth is not configured",
      "Linear request failed (429)",
      "Linear request failed (503)",
      "Linear request timed out",
      "Linear authorization was revoked; reconnect to continue",
      "Linear connection has expired; reconnect it to continue",
      "Linear token refresh failed",
      "Linear workspace could not be completed",
      "some unexpected linear failure",
    ]) {
      const result = classifyLinearFailure(err(message));
      expect(result.message, message).not.toMatch(/T3/);
    }
  });

  it("sanitizes an unknown Linear failure rather than forwarding its text", () => {
    expect(classifyLinearFailure(err("Bearer lin_oauth_secret exploded at /var/task/foo.js:12"))).toEqual({
      code: "unknown",
      message: "The Linear request could not be completed.",
      retryable: false,
    });
  });

  it("does not classify T3 wire errors as Linear transport failures", () => {
    // Provider patterns are distinct: a T3 429 must not become Linear rate
    // limiting, and vice versa.
    expect(classifyLinearFailure(err("T3 request failed (429)"))).toMatchObject({ code: "unknown" });
    expect(classifyT3Failure(err("Linear request failed (429)"))).toMatchObject({ code: "unknown" });
  });

  it("maps classified Linear failures to sensible HTTP statuses", () => {
    expect(linearStatus(classifyLinearFailure(err("unauthorized")))).toBe(401);
    expect(linearStatus(classifyLinearFailure(err("cross_origin_request")))).toBe(403);
    expect(linearStatus(classifyLinearFailure(err("Linear request failed (429)")))).toBe(429);
    expect(linearStatus(classifyLinearFailure(err("Linear OAuth is not configured")))).toBe(503);
    expect(linearStatus(classifyLinearFailure(err("Linear authorization was revoked; reconnect to continue")))).toBe(502);
    expect(linearStatus(classifyLinearFailure(err("Linear request failed (503)")))).toBe(502);
    expect(linearStatus(classifyLinearFailure(err("boom")))).toBe(502);
  });
});
