import { describe, expect, it } from "vitest";
import {
  MAX_ENDPOINT_LENGTH,
  TRUSTED_T3_DOMAIN,
  checkT3Endpoint,
  hostIsTrusted,
  normalizeEndpointInput,
} from "./t3EndpointPolicy";

/**
 * The shared trusted-endpoint policy is enforced by the Convex backend AND used
 * for the browser's early feedback. These tests pin the accept/reject table so
 * the two cannot drift, and so loosening the allowlist is a visible change.
 */
describe("host trust policy", () => {
  it("trusts the configured domain and its subdomains", () => {
    for (const host of [TRUSTED_T3_DOMAIN, `studio.${TRUSTED_T3_DOMAIN}`, `prod-e0eb33007bdbf8c3.${TRUSTED_T3_DOMAIN}`]) {
      expect(hostIsTrusted(host)).toBe(true);
    }
  });

  it("rejects lookalike hosts that merely contain the domain", () => {
    for (const host of [
      `evil-${TRUSTED_T3_DOMAIN}`,
      `not${TRUSTED_T3_DOMAIN}`,
      `${TRUSTED_T3_DOMAIN}.evil.com`,
      `x${TRUSTED_T3_DOMAIN}`,
      "",
    ]) {
      expect(hostIsTrusted(host)).toBe(false);
    }
  });
});

describe("checkT3Endpoint", () => {
  it("accepts trusted HTTPS /mcp endpoints", () => {
    for (const value of [
      `https://${TRUSTED_T3_DOMAIN}/mcp`,
      `https://studio.${TRUSTED_T3_DOMAIN}/mcp`,
      `https://prod-e0eb33007bdbf8c3.${TRUSTED_T3_DOMAIN}/mcp`,
      `HTTPS://studio.${TRUSTED_T3_DOMAIN}/mcp`,
    ]) {
      const result = checkT3Endpoint(value, { requireMcpPath: true });
      expect(result.ok, value).toBe(true);
    }
  });

  it("rejects every non-HTTPS scheme", () => {
    for (const value of [
      `http://studio.${TRUSTED_T3_DOMAIN}/mcp`,
      "http://127.0.0.1:3773/mcp",
      "http://192.168.1.10/mcp",
      "http://[::1]:3773/mcp",
      "ftp://studio.example/mcp",
      "javascript:alert(1)",
    ]) {
      expect(checkT3Endpoint(value, { requireMcpPath: true }), value).toEqual({ ok: false, reason: "not_https" });
    }
  });

  it("rejects URLs with no explicit authority or no scheme", () => {
    for (const value of ["", "studio.example/mcp", `https:${TRUSTED_T3_DOMAIN}/mcp`, `https:///${TRUSTED_T3_DOMAIN}/mcp`]) {
      expect(checkT3Endpoint(value, { requireMcpPath: true }), value).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects untrusted hosts while the scheme is still valid", () => {
    for (const value of [
      "https://t3.example.invalid/mcp",
      `https://evil-${TRUSTED_T3_DOMAIN}/mcp`,
      `https://${TRUSTED_T3_DOMAIN}.evil.com/mcp`,
    ]) {
      expect(checkT3Endpoint(value, { requireMcpPath: true }), value).toEqual({ ok: false, reason: "untrusted_host" });
    }
  });

  it("rejects embedded credentials, queries, fragments and explicit ports", () => {
    expect(checkT3Endpoint(`https://user:password@studio.${TRUSTED_T3_DOMAIN}/mcp`, { requireMcpPath: true })).toEqual({ ok: false, reason: "embedded_credentials" });
    expect(checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/mcp?token=secret`, { requireMcpPath: true })).toEqual({ ok: false, reason: "query_or_fragment" });
    expect(checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/mcp#fragment`, { requireMcpPath: true })).toEqual({ ok: false, reason: "query_or_fragment" });
    expect(checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/mcp?`, { requireMcpPath: true })).toEqual({ ok: false, reason: "query_or_fragment" });
    expect(checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}:8443/mcp`, { requireMcpPath: true })).toEqual({ ok: false, reason: "unsupported_port" });
  });

  it("requires the /mcp path only for the connection endpoint", () => {
    expect(checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/api/mcp`, { requireMcpPath: true })).toEqual({ ok: false, reason: "not_mcp_path" });
    // Discovery documents live at other paths on the same trusted origin.
    const discovery = checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/.well-known/oauth-authorization-server`);
    expect(discovery.ok).toBe(true);
  });

  it("rejects input beyond the stored-endpoint bound", () => {
    const oversized = `https://studio.${TRUSTED_T3_DOMAIN}/mcp?${"a".repeat(MAX_ENDPOINT_LENGTH)}`;
    expect(checkT3Endpoint(oversized, { requireMcpPath: true })).toEqual({ ok: false, reason: "too_long" });
  });

  it("returns a parsed URL only for accepted input", () => {
    const result = checkT3Endpoint(`https://studio.${TRUSTED_T3_DOMAIN}/mcp`, { requireMcpPath: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.href).toBe(`https://studio.${TRUSTED_T3_DOMAIN}/mcp`);
  });
});

describe("normalizeEndpointInput", () => {
  it("trims surrounding whitespace and a trailing /mcp slash", () => {
    expect(normalizeEndpointInput(`  https://studio.${TRUSTED_T3_DOMAIN}/mcp/  `)).toBe(`https://studio.${TRUSTED_T3_DOMAIN}/mcp`);
  });

  it("leaves other input untouched rather than guessing intent", () => {
    expect(normalizeEndpointInput(`https://studio.${TRUSTED_T3_DOMAIN}/mcp?a=1`)).toBe(`https://studio.${TRUSTED_T3_DOMAIN}/mcp?a=1`);
    expect(normalizeEndpointInput(`https://studio.${TRUSTED_T3_DOMAIN}/mcp/more`)).toBe(`https://studio.${TRUSTED_T3_DOMAIN}/mcp/more`);
    expect(normalizeEndpointInput("")).toBe("");
  });
});
