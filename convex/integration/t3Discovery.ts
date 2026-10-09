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
 * Returns the tool text (read-only catalog/project metadata). Never returns the
 * credential or any Authorization header.
 */
export const discoverT3Catalog = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    capabilities: v.string(),
    projects: v.string(),
    error: v.string(),
  }),
  handler: async (): Promise<{ ok: boolean; capabilities: string; projects: string; error: string }> => {
    const endpoint = process.env.T3_MCP_URL;
    const token = process.env.T3_MCP_TOKEN;
    if (!endpoint || !token) {
      return { ok: false, capabilities: "", projects: "", error: "missing_config" };
    }

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "helm-convex", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);

    // Accept the SDK's broader content union without narrowing it away.
    const text = (r: unknown) => {
      const c = (r as { content?: unknown } | null)?.content;
      if (Array.isArray(c) && c.length > 0) {
        const first = c[0] as { text?: unknown };
        if (typeof first?.text === "string") return first.text;
      }
      return "";
    };

    let capabilities = "";
    let projects = "";
    let error = "";
    try {
      capabilities = text(await client.callTool({ name: "orchestrator_capabilities", arguments: {} }));
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    try {
      projects = text(await client.callTool({ name: "t3_project_list", arguments: { limit: 50 } }));
    } catch (e) {
      error = error || String((e as Error)?.message ?? e).slice(0, 200);
    }
    await client.close().catch(() => undefined);
    return { ok: error === "", capabilities, projects, error };
  },
});
