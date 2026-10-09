"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/**
 * EGA-677 hosted T3 MCP verification (INTERNAL ONLY).
 *
 * Proves the authenticated Convex Cloud -> T3 path, not merely that the public
 * endpoint answers. Runs the real MCP StreamableHTTP handshake from the hosted
 * Convex runtime using the official SDK transport.
 *
 * Safety:
 *  - internalAction: not callable from a browser, the client SDK, or any public
 *    HTTP surface.
 *  - Reads credentials from Convex environment settings only. Returns no
 *    credential, header, or response body - only a fixed verdict shape.
 *  - Performs discovery only (initialize + tools/list). No launch, no mutation.
 */

const verifyValidator = v.object({
  ok: v.boolean(),
  /** Fixed stage results; never raw responses. */
  tokenConfigured: v.boolean(),
  endpointConfigured: v.boolean(),
  initialize: v.union(v.literal("success"), v.literal("failed"), v.literal("not_attempted")),
  toolsList: v.union(v.literal("success"), v.literal("failed"), v.literal("not_attempted")),
  serverName: v.union(v.string(), v.null()),
  serverVersion: v.union(v.string(), v.null()),
  toolCount: v.union(v.number(), v.null()),
  toolsWithInputSchema: v.union(v.number(), v.null()),
  toolNames: v.union(v.array(v.string()), v.null()),
  /** Sanitized error class, e.g. "unauthorized", "transport", "missing_config". */
  errorClass: v.union(
    v.literal("missing_config"),
    v.literal("unauthorized"),
    v.literal("transport"),
    v.literal("sdk_unavailable"),
    v.literal("unexpected"),
    v.null(),
  ),
  errorDetail: v.string(),
  durationMs: v.number(),
});

export const verifyHostedT3Mcp = internalAction({
  args: {},
  returns: verifyValidator,
  handler: async (): Promise<{
    ok: boolean;
    tokenConfigured: boolean;
    endpointConfigured: boolean;
    initialize: "success" | "failed" | "not_attempted";
    toolsList: "success" | "failed" | "not_attempted";
    serverName: string | null;
    serverVersion: string | null;
    toolCount: number | null;
    toolsWithInputSchema: number | null;
    toolNames: string[] | null;
    errorClass:
      | "missing_config"
      | "unauthorized"
      | "transport"
      | "sdk_unavailable"
      | "unexpected"
      | null;
    errorDetail: string;
    durationMs: number;
  }> => {
    const startedAt = Date.now();
    const base = {
      ok: false,
      tokenConfigured: false,
      endpointConfigured: false,
      initialize: "not_attempted" as const,
      toolsList: "not_attempted" as const,
      serverName: null,
      serverVersion: null,
      toolCount: null,
      toolsWithInputSchema: null,
      toolNames: null,
      errorClass: null,
      errorDetail: "",
    };

    const endpoint = process.env.T3_MCP_URL?.trim();
    const token = process.env.T3_MCP_TOKEN?.trim();

    if (!endpoint || !token) {
      return {
        ...base,
        endpointConfigured: Boolean(endpoint),
        tokenConfigured: Boolean(token),
        errorClass: "missing_config",
        errorDetail: !endpoint
          ? "T3_MCP_URL is not set in the deployment environment"
          : "T3_MCP_TOKEN is not set in the deployment environment",
        durationMs: Date.now() - startedAt,
      };
    }
    if (!endpoint.startsWith("https://")) {
      return {
        ...base,
        endpointConfigured: true,
        tokenConfigured: true,
        errorClass: "missing_config",
        errorDetail: "T3_MCP_URL must be an https URL for hosted use",
        durationMs: Date.now() - startedAt,
      };
    }

    // The official MCP SDK client transport.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );

    // The server parses the credential as authorization.startsWith("Bearer ").
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "helm-convex", version: "0.1.0" },
      { capabilities: {} },
    );

    let initializeOk = false;
    try {
      await client.connect(transport);
      const info = client.getServerVersion();
      const tools = await client.listTools();
      const list = tools.tools ?? [];
      initializeOk = true;

      return {
        ok: true,
        tokenConfigured: true,
        endpointConfigured: true,
        initialize: "success",
        toolsList: "success",
        serverName: info?.name ?? null,
        serverVersion: info?.version ?? null,
        toolCount: list.length,
        toolsWithInputSchema: list.filter((t) => Boolean(t.inputSchema)).length,
        toolNames: list.map((t) => t.name),
        errorClass: null,
        errorDetail: "",
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let errorClass: "unauthorized" | "transport" | "sdk_unavailable" | "unexpected" =
        "unexpected";
      if (/401|403|invalid_mcp_credential|unauthorized|forbidden/i.test(message)) {
        errorClass = "unauthorized";
      } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout|network/i.test(message)) {
        errorClass = "transport";
      } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) {
        errorClass = "sdk_unavailable";
      }
      return {
        ...base,
        tokenConfigured: true,
        endpointConfigured: true,
        initialize: initializeOk ? "success" : "failed",
        toolsList: "not_attempted",
        errorClass,
        // Sanitized: message only, never a response body or credential.
        errorDetail: message.slice(0, 200),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  },
});
