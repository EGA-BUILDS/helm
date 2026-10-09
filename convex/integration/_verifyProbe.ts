import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ReachabilityProbe } from "./reachability";
import type { SetupReport } from "./setup";

/**
 * EGA-677 TEMPORARY verification harness (INTERNAL ONLY) - DELETE AFTER USE.
 *
 * Thin pass-throughs that let the owner run the internal-only proof actions
 * from a trusted backend context (`npx convex run`), because the Convex CLI
 * cannot invoke `internalAction` directly. Both are `internalAction`, so they
 * remain unreachable from a browser or the public client SDK.
 *
 * They expose no credentials and mutate nothing.
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