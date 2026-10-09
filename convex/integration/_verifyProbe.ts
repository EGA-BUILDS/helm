import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ReachabilityProbe } from "./reachability";
import type { SetupReport } from "./setup";

type HostedT3McpVerification = {
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
};

/**
 * EGA-677 TEMPORARY verification harness (INTERNAL ONLY) - DELETE AFTER USE.
 *
 * Thin pass-throughs that let the owner run the internal-only proof actions
 * from a trusted backend context (`npx convex run`), because the Convex CLI
 * cannot invoke `internalAction` directly. All entries are `internalAction`, so
 * they remain unreachable from a browser or the public client SDK.
 *
 * They expose no credentials and mutate nothing.
 *
 * `runLinearVerification` is a pass-through to the other agent's
 * `verifyHelmProjectAccess`. It returns only the closed verdict shape; the
 * LINEAR_API_KEY itself never crosses this boundary.
 */

const probeValidator = v.object({
  reachable: v.boolean(),
  status: v.union(v.number(), v.null()),
  outcome: v.union(
    v.literal("reachable"),
    v.literal("reachable-auth-required"),
    v.literal("reachable-unexpected-status"),
    v.literal("unreachable-dns"),
    v.literal("unreachable-refused"),
    v.literal("unreachable-timeout"),
    v.literal("unreachable-other"),
  ),
  detail: v.string(),
  durationMs: v.number(),
});

const setupReportValidator = v.object({
  checks: v.array(
    v.object({
      name: v.string(),
      variable: v.string(),
      state: v.union(
        v.literal("missing"),
        v.literal("configured"),
        v.literal("placeholder"),
      ),
      message: v.string(),
    }),
  ),
  readyForHostedDiscovery: v.boolean(),
});

const linearVerificationValidator = v.object({
  authentication: v.union(
    v.literal("verified"),
    v.literal("failed"),
    v.literal("inconclusive"),
  ),
  projectAccess: v.union(
    v.literal("verified"),
    v.literal("not_found_or_inaccessible"),
    v.literal("wrong_project"),
    v.literal("not_checked"),
    v.literal("inconclusive"),
  ),
  issuesAccess: v.union(
    v.literal("verified"),
    v.literal("failed"),
    v.literal("not_checked"),
    v.literal("inconclusive"),
  ),
  configuredProjectMatchesHelm: v.union(v.boolean(), v.null()),
  sampledIssueCount: v.union(v.number(), v.null()),
  moreIssuesAvailable: v.union(v.boolean(), v.null()),
  error: v.union(
    v.literal("missing_configuration"),
    v.literal("authentication_rejected"),
    v.literal("linear_api_error"),
    v.literal("linear_unavailable"),
    v.literal("unexpected_response"),
    v.null(),
  ),
});

export const runReachabilityProbe = internalAction({
  args: { targetUrl: v.string() },
  returns: probeValidator,
  handler: async (ctx, args): Promise<ReachabilityProbe> => {
    return await ctx.runAction(
      internal.integration.reachability.probeEndpointReachability,
      { targetUrl: args.targetUrl },
    );
  },
});

export const runSetupReport = internalAction({
  args: {},
  returns: setupReportValidator,
  handler: async (ctx): Promise<SetupReport> => {
    return await ctx.runAction(
      internal.integration.setup.reportIntegrationSetup,
      {},
    );
  },
});

/**
 * Runs the Linear hosted verifier end to end (auth + project + issues).
 * Added to reconcile the owner's "authenticated Linear verifier passed"
 * claim against the action's actual hosted result.
 */
type LinearVerification = {
  authentication: "verified" | "failed" | "inconclusive";
  projectAccess:
    | "verified"
    | "not_found_or_inaccessible"
    | "wrong_project"
    | "not_checked"
    | "inconclusive";
  issuesAccess: "verified" | "failed" | "not_checked" | "inconclusive";
  configuredProjectMatchesHelm: boolean | null;
  sampledIssueCount: number | null;
  moreIssuesAvailable: boolean | null;
  error:
    | "missing_configuration"
    | "authentication_rejected"
    | "linear_api_error"
    | "linear_unavailable"
    | "unexpected_response"
    | null;
};

export const runLinearVerification = internalAction({
  args: {},
  returns: linearVerificationValidator,
  handler: async (ctx): Promise<LinearVerification> => {
    return await ctx.runAction(
      internal.integration.linearVerification.verifyHelmProjectAccess,
      {},
    );
  },
});

/**
 * EGA-677 (INTERNAL ONLY): runs the hosted T3 MCP verification from the hosted
 * Convex runtime. Pass-through only; returns the closed verdict shape.
 */
export const runHostedT3McpVerification = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    tokenConfigured: v.boolean(),
    endpointConfigured: v.boolean(),
    initialize: v.union(v.literal("success"), v.literal("failed"), v.literal("not_attempted")),
    toolsList: v.union(v.literal("success"), v.literal("failed"), v.literal("not_attempted")),
    serverName: v.union(v.string(), v.null()),
    serverVersion: v.union(v.string(), v.null()),
    toolCount: v.union(v.number(), v.null()),
    toolsWithInputSchema: v.union(v.number(), v.null()),
    toolNames: v.union(v.array(v.string()), v.null()),
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
  }),
  handler: async (ctx): Promise<HostedT3McpVerification> => {
    return await ctx.runAction(
      internal.integration.t3Mcp.verifyHostedT3Mcp,
      {},
    );
  },
});

/** EGA-677 (INTERNAL ONLY): read-only T3 catalog/project discovery pass-through. */
export const runT3Discovery = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    capabilities: v.string(),
    projects: v.string(),
    error: v.string(),
  }),
  handler: async (ctx): Promise<{ ok: boolean; capabilities: string; projects: string; error: string }> => {
    return await ctx.runAction(internal.integration.t3Discovery.discoverT3Catalog, {});
  },
});
