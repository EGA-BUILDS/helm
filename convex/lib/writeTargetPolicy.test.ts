/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  authorizeNativeWriteTarget,
  guardNativeWriteTarget,
  NATIVE_WRITE_ENDPOINT_VAR,
  NATIVE_WRITE_ENVIRONMENTS_VAR,
  NATIVE_WRITE_REFUSAL_DETAIL,
  resolveNativeWriteTargetConfig,
} from "./writeTargetPolicy";

const ENDPOINT = "https://approved.t3coderelay.com/mcp";
const ENV_ID = "env-approved";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [NATIVE_WRITE_ENDPOINT_VAR]: ENDPOINT,
    [NATIVE_WRITE_ENVIRONMENTS_VAR]: ENV_ID,
    ...overrides,
  };
}

describe("writeTargetPolicy: configuration is fail-closed", () => {
  it("resolves a fully configured target", () => {
    const config = resolveNativeWriteTargetConfig(env());
    expect(config).toEqual({ ok: true, endpoint: ENDPOINT, environments: [ENV_ID] });
  });

  it("accepts several environments and trims entries", () => {
    const config = resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: ` env-a , ${ENV_ID} , env-b ` }));
    expect(config).toEqual({ ok: true, endpoint: ENDPOINT, environments: ["env-a", ENV_ID, "env-b"] });
  });

  it("normalizes the trailing slash of /mcp/ on the approved endpoint", () => {
    const config = resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENDPOINT_VAR]: `${ENDPOINT}/` }));
    expect(config).toEqual({ ok: true, endpoint: ENDPOINT, environments: [ENV_ID] });
  });

  it("refuses when the approved endpoint is absent", () => {
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENDPOINT_VAR]: undefined }))).toEqual({
      ok: false,
      reason: "endpoint_not_configured",
    });
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENDPOINT_VAR]: "   " }))).toEqual({
      ok: false,
      reason: "endpoint_not_configured",
    });
  });

  it("refuses when no approved environment is configured", () => {
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: undefined }))).toEqual({
      ok: false,
      reason: "environments_not_configured",
    });
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: "" }))).toEqual({
      ok: false,
      reason: "environments_not_configured",
    });
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: "   " }))).toEqual({
      ok: false,
      reason: "environments_not_configured",
    });
  });

  it("treats a present separator-only list as malformed, not unset", () => {
    // The variable IS configured, with no usable entries. Naming it malformed
    // is the honest classification and still fails closed.
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: " , , " }))).toEqual({
      ok: false,
      reason: "environments_malformed",
    });
  });

  it.each([
    ["http://approved.t3coderelay.com/mcp", "not https"],
    ["https://user:pass@approved.t3coderelay.com/mcp", "embedded credentials"],
    ["https://approved.t3coderelay.com/mcp?x=1", "query string"],
    ["https://approved.t3coderelay.com/mcp#frag", "fragment"],
    ["not a url", "not a URL"],
  ])("refuses a malformed approved endpoint (%s: %s)", (value) => {
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENDPOINT_VAR]: value }))).toEqual({
      ok: false,
      reason: "endpoint_malformed",
    });
  });

  it.each([
    ["env one", "whitespace"],
    ["env-one, env two", "whitespace inside a later entry"],
    ["env/one", "separator outside the allowed charset"],
    ["env,one,", "trailing comma leaves an empty entry"],
    [",env,one", "leading comma leaves an empty entry"],
  ])("validates the environment list strictly (%s: %s)", (value) => {
    expect(resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: value }))).toEqual({
      ok: false,
      reason: "environments_malformed",
    });
  });

  it("rejects an empty entry in the middle instead of skipping it", () => {
    // Regression: `env-a,,env-b` previously degraded to `env-a,env-b`, which
    // contradicted the documented "malformed entries reject the whole list"
    // contract and could authorize an unintended target.
    expect(
      resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: "env-a,,env-b" })),
    ).toEqual({ ok: false, reason: "environments_malformed" });
    expect(
      resolveNativeWriteTargetConfig(env({ [NATIVE_WRITE_ENVIRONMENTS_VAR]: " env-a , , env-b " })),
    ).toEqual({ ok: false, reason: "environments_malformed" });
  });
});

describe("writeTargetPolicy: authorize a stored grant", () => {
  const config = resolveNativeWriteTargetConfig(env());

  it("accepts the exact approved endpoint and environment", () => {
    expect(authorizeNativeWriteTarget({ endpoint: ENDPOINT, environmentId: ENV_ID }, config)).toEqual({ ok: true });
  });

  it("accepts a stored endpoint with the canonical trailing slash", () => {
    expect(
      authorizeNativeWriteTarget({ endpoint: `${ENDPOINT}/`, environmentId: ENV_ID }, config),
    ).toEqual({ ok: true });
  });

  it("refuses a different endpoint", () => {
    const check = authorizeNativeWriteTarget(
      { endpoint: "https://real-relay.t3coderelay.com/mcp", environmentId: ENV_ID },
      config,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("endpoint_mismatch");
      expect(check.detail).toBe(NATIVE_WRITE_REFUSAL_DETAIL.endpoint_mismatch);
    }
  });

  it("refuses a hostname-suffix lookalike rather than matching a substring", () => {
    const check = authorizeNativeWriteTarget(
      { endpoint: "https://approved.t3coderelay.com.evil.example/mcp", environmentId: ENV_ID },
      config,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("endpoint_mismatch");
  });

  it("refuses a different environment", () => {
    const check = authorizeNativeWriteTarget({ endpoint: ENDPOINT, environmentId: "env-real" }, config);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("environment_mismatch");
      expect(check.detail).toBe(NATIVE_WRITE_REFUSAL_DETAIL.environment_mismatch);
    }
  });

  it("refuses everything when the configuration is absent", () => {
    const check = authorizeNativeWriteTarget(
      { endpoint: ENDPOINT, environmentId: ENV_ID },
      resolveNativeWriteTargetConfig({}),
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("endpoint_not_configured");
  });

  it("never echoes a configured value in a refusal detail", () => {
    const configured = {
      [NATIVE_WRITE_ENDPOINT_VAR]: ENDPOINT,
      [NATIVE_WRITE_ENVIRONMENTS_VAR]: "env-secret-looking-value",
    };
    const check = authorizeNativeWriteTarget(
      { endpoint: "https://elsewhere.t3coderelay.com/mcp", environmentId: "env-real" },
      resolveNativeWriteTargetConfig(configured),
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.detail).not.toContain(ENDPOINT);
      expect(check.detail).not.toContain("env-secret-looking-value");
      expect(check.detail).not.toContain("https://");
    }
  });
});

describe("writeTargetPolicy: guard convenience", () => {
  it("reads the supplied environment, not a caller argument", () => {
    expect(guardNativeWriteTarget({ endpoint: ENDPOINT, environmentId: ENV_ID }, env())).toEqual({ ok: true });
    expect(guardNativeWriteTarget({ endpoint: ENDPOINT, environmentId: ENV_ID }, {})).toMatchObject({
      ok: false,
      reason: "endpoint_not_configured",
    });
  });
});
