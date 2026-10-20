/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * M-3: setup diagnostics must report ISOLATED dispatch configuration
 * separately from PRIVILEGED discovery configuration, and a passing discovery
 * check must never imply dispatch readiness. Missing isolated credentials fail
 * closed. No secret value is ever present in the report.
 */

const modules = import.meta.glob("./**/*.ts");

const PRIVILEGED_ENDPOINT = "https://privileged.example.invalid/mcp";
const PRIVILEGED_TOKEN = "PRIVILEGED_TOKEN_SENTINEL_1a";
const ISOLATED_ENDPOINT = "https://isolated.example.invalid/mcp";
const ISOLATED_TOKEN = "ISOLATED_TOKEN_SENTINEL_2b";
const ISOLATED_PROJECT = "t3-project-placeholder";

const ENV_KEYS = ["T3_MCP_URL", "T3_MCP_TOKEN", "T3_MCP_URL_ISOLATED", "T3_MCP_TOKEN_ISOLATED", "T3_PROJECT_ID_ISOLATED"] as const;
let savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
    const value = values[key];
    if (value !== undefined) process.env[key] = value;
  }
}

describe("integration setup report (M-3)", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("privileged-only configuration: discovery ready, dispatch NOT ready, fail closed", async () => {
    setEnv({ T3_MCP_URL: PRIVILEGED_ENDPOINT, T3_MCP_TOKEN: PRIVILEGED_TOKEN });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    expect(report.readyForHostedDiscovery).toBe(true);
    // The whole point of M-3: discovery success must never imply dispatch.
    expect(report.readyForIsolatedDispatch).toBe(false);
    expect(report.dispatchEligibility).toBe("isolated_not_configured");
  });

  it("fully configured isolated pair: dispatch eligible", async () => {
    setEnv({
      T3_MCP_URL: PRIVILEGED_ENDPOINT,
      T3_MCP_TOKEN: PRIVILEGED_TOKEN,
      T3_MCP_URL_ISOLATED: ISOLATED_ENDPOINT,
      T3_MCP_TOKEN_ISOLATED: ISOLATED_TOKEN,
      T3_PROJECT_ID_ISOLATED: ISOLATED_PROJECT,
    });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    expect(report.readyForIsolatedDispatch).toBe(true);
    expect(report.dispatchEligibility).toBe("isolated_configured");
    expect(report.readyForHostedDiscovery).toBe(true);
  });

  it("half-configured isolated pair is incomplete, not eligible", async () => {
    setEnv({ T3_MCP_URL_ISOLATED: ISOLATED_ENDPOINT });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    expect(report.readyForIsolatedDispatch).toBe(false);
    expect(report.dispatchEligibility).toBe("isolated_incomplete");
  });

  it("complete credentials without a trusted project binding are not dispatch-ready", async () => {
    setEnv({ T3_MCP_URL_ISOLATED: ISOLATED_ENDPOINT, T3_MCP_TOKEN_ISOLATED: ISOLATED_TOKEN });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    expect(report.readyForIsolatedDispatch).toBe(false);
    expect(report.dispatchEligibility).toBe("isolated_incomplete");
  });

  it.each([
    "not a url",
    "http://isolated.example.invalid/mcp",
    "https://user:pass@isolated.example.invalid/mcp",
    "   ",
  ])("reports invalid isolated URL as not dispatch-ready (%s)", async (endpoint) => {
    setEnv({
      T3_MCP_URL_ISOLATED: endpoint,
      T3_MCP_TOKEN_ISOLATED: ISOLATED_TOKEN,
      T3_PROJECT_ID_ISOLATED: ISOLATED_PROJECT,
    });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    expect(report.checks.find((c) => c.name === "t3McpUrlIsolated")?.state).toBe(
      endpoint.trim() ? "invalid" : "missing",
    );
    expect(report.readyForIsolatedDispatch).toBe(false);
  });

  it("placeholder values do not count as configured", async () => {
    setEnv({
      T3_MCP_URL_ISOLATED: "https://YOUR_ISOLATED_T3_MCP_ENDPOINT/mcp",
      T3_MCP_TOKEN_ISOLATED: "",
    });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const url = report.checks.find((c) => c.name === "t3McpUrlIsolated");
    const token = report.checks.find((c) => c.name === "t3McpTokenIsolated");
    expect(url?.state).toBe("placeholder");
    expect(token?.state).toBe("missing");
    expect(report.readyForIsolatedDispatch).toBe(false);
  });

  it("the report never contains any configured secret value", async () => {
    setEnv({
      T3_MCP_URL: PRIVILEGED_ENDPOINT,
      T3_MCP_TOKEN: PRIVILEGED_TOKEN,
      T3_MCP_URL_ISOLATED: ISOLATED_ENDPOINT,
      T3_MCP_TOKEN_ISOLATED: ISOLATED_TOKEN,
      T3_PROJECT_ID_ISOLATED: ISOLATED_PROJECT,
    });
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const serialized = JSON.stringify(report);
    for (const sentinel of [PRIVILEGED_TOKEN, ISOLATED_TOKEN]) {
      expect(serialized).not.toContain(sentinel);
    }
    // Endpoints are URLs, not secrets, and never carried userinfo here.
    expect(serialized).not.toMatch(/:\/\/[^"/\s]+:[^"/\s]+@/);
  });

  it("guidance names the isolated variables and their fail-closed behavior", async () => {
    setEnv({});
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const url = report.checks.find((c) => c.name === "t3McpUrlIsolated");
    const token = report.checks.find((c) => c.name === "t3McpTokenIsolated");
    expect(url?.variable).toBe("T3_MCP_URL_ISOLATED");
    expect(url?.message).toContain("T3_MCP_URL_ISOLATED");
    expect(url?.message).not.toContain(ISOLATED_ENDPOINT);
    expect(token?.variable).toBe("T3_MCP_TOKEN_ISOLATED");
    expect(token?.message).toContain("fail closed");
  });

  it("privileged guidance states it is discovery-only, never dispatch", async () => {
    setEnv({});
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const url = report.checks.find((c) => c.name === "t3McpUrl");
    expect(url?.message).toContain("PRIVILEGED DISCOVERY ONLY");
  });
});

describe("integration setup report (EGA-770 env validation wiring)", () => {
  const REQUIRED = {
    NEXT_PUBLIC_CONVEX_URL: "https://dev.example.convex.cloud",
    HELM_APP_URL: "https://helm-dev.example.vercel.app",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abcdefghijklmnopqrstuvwxyz",
    CLERK_FRONTEND_API_URL: "https://clerk-dev.example.com",
    HELM_OWNER_SUBJECT: "user_2abc",
    LINEAR_CLIENT_ID: "linear-client-id",
    T3_OAUTH_ENCRYPTION_KEY_V1: Buffer.from("a".repeat(32)).toString("base64"),
    LINEAR_OAUTH_ENCRYPTION_KEY_V1: Buffer.from("a".repeat(32)).toString("base64"),
    T3_MCP_URL: "https://t3-privileged.example/mcp",
    T3_MCP_TOKEN: "privileged-token-placeholder",
    T3_MCP_URL_ISOLATED: "https://t3-isolated.example/mcp",
    T3_MCP_TOKEN_ISOLATED: "isolated-token-placeholder",
    T3_PROJECT_ID_ISOLATED: "t3-project-placeholder",
    LINEAR_API_KEY: "lin_api_placeholder",
    LINEAR_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
  } as const;

  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of Object.keys(REQUIRED)) saved[key] = process.env[key];
    for (const key of Object.keys(REQUIRED)) delete process.env[key];
    for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION;
    delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
  });

  it("surfaces a missing required variable as a specific environment issue", async () => {
    delete process.env.LINEAR_CLIENT_ID;
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const issue = report.environment.issues.find((i: { variable: string }) => i.variable === "LINEAR_CLIENT_ID");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("LINEAR_CLIENT_ID");
    expect(issue?.message).toContain("Linear OAuth");
    expect(report.environment.ok).toBe(false);
  });

  it("environment report contains no secret value", async () => {
    const secret = "SUPER_SECRET_VALUE_99";
    // Drive an issue path for the sentinel variable (non-URL secret).
    process.env.CLERK_FRONTEND_API_URL = secret;
    const t = convexTest(schema, modules);
    const report = await t.action(internal.integration.setup.reportIntegrationSetup, {});
    const issue = report.environment.issues.find((i: { variable: string }) => i.variable === "CLERK_FRONTEND_API_URL");
    expect(issue).toBeDefined();
    // Inspect issues explicitly.
    for (const item of report.environment.issues) {
      expect(item.message).not.toContain(secret);
      expect(item.variable).not.toContain(secret);
    }
    const serialized = JSON.stringify(report.environment.issues);
    expect(serialized).not.toContain(secret);
  });
});
