"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/**
 * EGA-677 read-only T3 discovery (INTERNAL ONLY).
 *
 * Calls ONLY orchestration:read tools - orchestrator_capabilities and
 * t3_project_list - to discover the real provider/model catalog and registered
 * projects from the hosted Convex runtime. No launch, no operate scope, no
 * mutation.
 *
 * Returns fixed availability categories only. Remote tool text and SDK errors
 * are untrusted and never cross this action boundary.
 */
export const discoverT3Catalog = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    capabilities: v.union(v.literal("available"), v.literal("unavailable")),
    projects: v.union(v.literal("available"), v.literal("unavailable")),
    error: v.union(v.literal(""), v.literal("discovery_failed"), v.literal("missing_config")),
  }),
  handler: async (): Promise<{
    ok: boolean;
    capabilities: "available" | "unavailable";
    projects: "available" | "unavailable";
    error: "" | "discovery_failed" | "missing_config";
  }> => {
    const endpoint = process.env.T3_MCP_URL;
    const token = process.env.T3_MCP_TOKEN;
    if (!endpoint || !token) {
      return {
        ok: false,
        capabilities: "unavailable",
        projects: "unavailable",
        error: "missing_config",
      };
    }

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const hasText = (r: unknown) => {
      const c = (r as { content?: unknown } | null)?.content;
      if (Array.isArray(c) && c.length > 0) {
        const first = c[0] as { text?: unknown };
        return typeof first?.text === "string" && first.text.length > 0;
      }
      return false;
    };

    let capabilities: "available" | "unavailable" = "unavailable";
    let projects: "available" | "unavailable" = "unavailable";
    let error: "" | "discovery_failed" = "";
    let closeClient: (() => Promise<void>) | undefined;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "helm-convex", version: "0.1.0" }, { capabilities: {} });
      closeClient = () => client.close();
      await client.connect(transport);
      try {
        const response = await client.callTool({ name: "orchestrator_capabilities", arguments: {} });
        capabilities = hasText(response) ? "available" : "unavailable";
      } catch {
        error = "discovery_failed";
      }
      try {
        const response = await client.callTool({ name: "t3_project_list", arguments: { limit: 50 } });
        projects = hasText(response) ? "available" : "unavailable";
      } catch {
        error = "discovery_failed";
      }
    } catch {
      error = "discovery_failed";
    } finally {
      await closeClient?.().catch(() => undefined);
    }
    return { ok: error === "", capabilities, projects, error };
  },
});
