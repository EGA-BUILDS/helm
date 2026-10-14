import { describe, expect, it } from "vitest";
import { classifyT3Failure } from "./t3Failure";

const err = (message: string) => new Error(message);

/**
 * Every branch must return a sanitized, fixed sentence. These tests assert both
 * the classification and that upstream text never reaches the owner.
 */
describe("T3 failure classification", () => {
  it("keeps authorization and deployment refusals fail-closed and non-retryable", () => {
    expect(classifyT3Failure(err("unauthorized"))).toMatchObject({ code: "access_denied", retryable: false });
    // The configured origin is never echoed back to the caller.
    const origin = classifyT3Failure(err("cross_origin_request"));
    expect(origin.code).toBe("origin_mismatch");
    expect(origin.retryable).toBe(false);
    expect(origin.message).not.toContain("cross_origin_request");
  });

  it("reports a missing deployment setting without naming the setting", () => {
    const result = classifyT3Failure(err("T3 OAuth encryption is not configured"));
    expect(result.code).toBe("misconfigured");
    expect(result.retryable).toBe(false);
    expect(result.message).not.toMatch(/encryption|key/i);
    expect(classifyT3Failure(err("Helm callback URL is not configured")).code).toBe("misconfigured");
  });

  it("distinguishes an OAuth discovery mismatch from an unreachable endpoint", () => {
    for (const message of [
      "T3 resource discovery did not match this endpoint",
      "T3 OAuth issuer did not match discovery",
      "T3 OAuth issuer is not trusted",
      "T3 OAuth endpoint is not trusted",
      "T3 OAuth does not support the required authorization flow",
    ]) {
      expect(classifyT3Failure(err(message)), message).toMatchObject({ code: "discovery_mismatch", retryable: false });
    }
  });

  it("reports an unsupported endpoint as a non-retryable policy violation", () => {
    expect(classifyT3Failure(err("Only trusted HTTPS T3 Connect MCP endpoints are supported"))).toMatchObject({ code: "invalid_endpoint", retryable: false });
    expect(classifyT3Failure(err("Enter a valid T3 Connect URL"))).toMatchObject({ code: "invalid_endpoint", retryable: false });
  });

  it("treats a DNS failure as temporarily retryable, not permanent", () => {
    for (const message of [
      "T3 endpoint did not resolve to a public address",
      "getaddrinfo ENOTFOUND studio.t3coderelay.com",
      "queryA EAI_AGAIN",
    ]) {
      expect(classifyT3Failure(err(message)), message).toMatchObject({ code: "endpoint_unresolved", retryable: true });
    }
  });

  it("classifies transient transport conditions as retryable", () => {
    expect(classifyT3Failure(err("T3 request timed out"))).toMatchObject({ code: "unreachable", retryable: true });
    expect(classifyT3Failure(err("T3 environment could not be reached"))).toMatchObject({ code: "unreachable", retryable: true });
    expect(classifyT3Failure(err("T3 request failed (503)"))).toMatchObject({ code: "unreachable", retryable: true });
    expect(classifyT3Failure(err("T3 request failed (429)"))).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("separates revoked and expired authorization from a transport failure", () => {
    expect(classifyT3Failure(err("T3 authorization was revoked; reconnect to continue"))).toMatchObject({ code: "revoked", retryable: false });
    expect(classifyT3Failure(err("T3 connection has expired; reconnect it to continue"))).toMatchObject({ code: "connection_expired", retryable: false });
  });

  it("sanitizes an unknown failure rather than forwarding its text", () => {
    const result = classifyT3Failure(err("Bearer sk_live_super_secret exploded at /var/task/foo.js:12"));
    expect(result).toEqual({ code: "unknown", message: "The T3 request could not be completed.", retryable: false });
  });

  it("handles non-Error throwables with the same safe default", () => {
    expect(classifyT3Failure("some string")).toEqual({ code: "unknown", message: "The T3 request could not be completed.", retryable: false });
    expect(classifyT3Failure(undefined)).toEqual({ code: "unknown", message: "The T3 request could not be completed.", retryable: false });
  });
});
