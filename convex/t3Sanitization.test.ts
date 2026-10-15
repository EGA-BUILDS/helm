/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const mock = vi.hoisted(() => ({ connect: vi.fn(), callTool: vi.fn(), close: vi.fn(), listTools: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(...args: unknown[]) { return mock.connect(...args); }
    callTool(...args: unknown[]) { return mock.callTool(...args); }
    listTools(...args: unknown[]) { return mock.listTools(...args); }
    getServerVersion() { return { name: "REMOTE_ID_SENTINEL", version: "REMOTE_VERSION_SENTINEL" }; }
    close(...args: unknown[]) { return mock.close(...args); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

const modules = import.meta.glob("./**/*.ts");
const ENV_KEYS = ["T3_MCP_URL", "T3_MCP_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("T3 diagnostic output sanitization", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = key === "T3_MCP_URL" ? "https://safe.example.invalid/mcp" : "shortalpha";
    }
    mock.connect.mockResolvedValue(undefined);
    mock.close.mockResolvedValue(undefined);
    mock.callTool.mockReset();
    mock.listTools.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("discovery reports availability only and never returns remote text or thrown credentials", async () => {
    const t = convexTest(schema, modules);
    mock.callTool.mockResolvedValue({ content: [{ text: "shortalpha Bearer JWT_SENTINEL" }] });
    const success = await t.action(internal.integration.t3Discovery.discoverT3Catalog, {});
    expect(success).toEqual({
      ok: true,
      capabilities: "available",
      projects: "available",
      error: "",
    });
    expect(JSON.stringify(success)).not.toMatch(/shortalpha|Bearer|JWT_SENTINEL/);

    mock.connect.mockRejectedValueOnce(new Error("https://user:pass@example.invalid/?token=shortalpha"));
    const failed = await t.action(internal.integration.t3Discovery.discoverT3Catalog, {});
    expect(failed).toMatchObject({ ok: false, error: "discovery_failed" });
    expect(JSON.stringify(failed)).not.toMatch(/user:pass|shortalpha|token=/);
  });

  it("MCP verification returns fixed safe errors and omits remote metadata", async () => {
    const t = convexTest(schema, modules);
    mock.listTools.mockResolvedValue({ tools: [{ name: "REMOTE_TOOL_SENTINEL", inputSchema: {} }] });
    const success = await t.action(internal.integration.t3Mcp.verifyHostedT3Mcp, {});
    expect(success).toMatchObject({ ok: true, serverName: null, serverVersion: null, toolNames: null, toolCount: 1 });
    expect(JSON.stringify(success)).not.toMatch(/REMOTE_ID_SENTINEL|REMOTE_VERSION_SENTINEL|REMOTE_TOOL_SENTINEL/);

    mock.connect.mockRejectedValueOnce(new Error("Basic shortalpha Bearer JWT_SENTINEL session=SESSION_SENTINEL"));
    const failed = await t.action(internal.integration.t3Mcp.verifyHostedT3Mcp, {});
    expect(failed.errorDetail).toBe("MCP verification failed");
    expect(JSON.stringify(failed)).not.toMatch(/shortalpha|JWT_SENTINEL|SESSION_SENTINEL|Basic|Bearer/);
  });
});
