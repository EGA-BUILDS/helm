/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// Per convex/_generated/ai/guidelines.md: build the module registry with
// import.meta.glob and drive functions through generated api references.
const modules = import.meta.glob("./**/*.ts");

test("health.check returns { status: 'ok' } with no arguments and no auth", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.health.check, {});
  expect(result).toEqual({ status: "ok" });
});

// --- reachability probe -----------------------------------------------------

test("reachability probe rejects a non-http(s) URL without fetching", async () => {
  const t = convexTest(schema, modules);
  const result = await t.action(
    internal.integration.reachability.probeEndpointReachability,
    { targetUrl: "ftp://example.invalid/mcp" },
  );
  expect(result.reachable).toBe(false);
  expect(result.outcome).toBe("unreachable-other");
  expect(result.detail).toContain("absolute http(s) URL");
});

test("reachability probe classifies an unresolvable host as unreachable-dns", async () => {
  const t = convexTest(schema, modules);
  const result = await t.action(
    internal.integration.reachability.probeEndpointReachability,
    // .invalid is reserved by RFC 2606 and never resolves.
    { targetUrl: "https://nonexistent.invalid/mcp" },
  );
  expect(result.reachable).toBe(false);
  // The classifier inspects the fetch error's cause chain (ENOTFOUND), so this
  // must not collapse into the generic unreachable-other bucket.
  expect(result.outcome).toBe("unreachable-dns");
});

test("reachability probe returns a closed verdict surface with no secret material", async () => {
  const t = convexTest(schema, modules);
  const result = await t.action(
    internal.integration.reachability.probeEndpointReachability,
    { targetUrl: "https://nonexistent.invalid/mcp" },
  );
  // The verdict surface is fixed and closed: exactly these keys.
  expect(Object.keys(result).sort()).toEqual(
    ["detail", "durationMs", "outcome", "reachable", "status"].sort(),
  );
  // A negative result must not leak a body or credentials.
  expect(result.detail).not.toMatch(/bearer|token|secret/i);
});

// --- setup diagnostics ------------------------------------------------------

test("setup report marks absent variables as missing and stays actionable", async () => {
  const t = convexTest(schema, modules);
  const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
  const byName = new Map(report.checks.map((c) => [c.name, c]));

  expect(report.readyForHostedDiscovery).toBe(false);
  for (const check of report.checks) {
    // Under vitest the Convex test env supplies no integration credentials,
    // so everything must report as missing with non-empty guidance.
    expect(check.state).toBe("missing");
    expect(check.message.length).toBeGreaterThan(0);
  }
  expect(byName.get("t3McpUrl")?.message).toContain("T3_MCP_URL");
});

test("setup report never returns any environment variable value", async () => {
  const t = convexTest(schema, modules);

  // Hermetic: populate recognizable sentinel values, then assert none of them
  // appear in the report. Without real values present this test cannot fail.
  const sentinels: Record<string, string> = {
    T3_MCP_URL: "https://sentinel-t3.example.invalid/mcp",
    T3_MCP_TOKEN: "SENTINEL_T3_TOKEN_VALUE",
    LINEAR_API_KEY: "SENTINEL_LINEAR_KEY_VALUE",
    LINEAR_PROJECT_ID: "SENTINEL_LINEAR_PROJECT_ID",
    CLERK_FRONTEND_API_URL: "SENTINEL_CLERK_ISSUER",
    HELM_OWNER_SUBJECT: "user_SENTINEL_OWNER_SUBJECT",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(sentinels)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const report = await t.action(
      internal.integration.setup.reportIntegrationSetup,
      {},
    );
    const serialized = JSON.stringify(report);

    // No configured value may leak into the report in any field. (Compare whole
    // values only: partial fragments can collide with variable *names*, which
    // are intentionally present.)
    for (const value of Object.values(sentinels)) {
      expect(serialized).not.toContain(value);
    }
    // The distinctive token present in every sentinel.
    expect(serialized).not.toMatch(/SENTINEL/);
    // Variable *names* are expected and safe.
    expect(serialized).toContain("T3_MCP_TOKEN");

    // With T3 endpoint + token set, hosted discovery is unblocked.
    expect(report.readyForHostedDiscovery).toBe(true);
    const t3Token = report.checks.find((c) => c.name === "t3McpToken");
    expect(t3Token?.state).toBe("configured");

    // Every check exposes only the closed key set.
    for (const check of report.checks) {
      expect(Object.keys(check).sort()).toEqual(
        ["message", "name", "state", "variable"].sort(),
      );
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("setup report detects leftover .env.example placeholders", async () => {
  const t = convexTest(schema, modules);
  const saved = process.env.T3_MCP_URL;
  process.env.T3_MCP_URL = "https://YOUR_PUBLIC_T3_MCP_ENDPOINT/mcp";
  try {
    const report = await t.action(
      internal.integration.setup.reportIntegrationSetup,
      {},
    );
    const check = report.checks.find((c) => c.name === "t3McpUrl");
    // A placeholder must never count as configured.
    expect(check?.state).toBe("placeholder");
    expect(check?.message).toContain("placeholder");
    expect(report.readyForHostedDiscovery).toBe(false);
  } finally {
    if (saved === undefined) {
      delete process.env.T3_MCP_URL;
    } else {
      process.env.T3_MCP_URL = saved;
    }
  }
});
