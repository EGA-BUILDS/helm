"use node";

import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { classifyConnectionError, type ConnectionErrorKind } from "./lib/connectionHealth";
import { verifyLinearProject, verifyT3Project, type AdapterResult } from "./lib/projectConnectionAdapters";
import { resolveIsolatedDispatchConfig } from "./lib/dispatchConfig";

const kindValidator = v.union(v.literal("linear"), v.literal("t3"));
const grantValidator = v.object({ subject: v.string(), issuer: v.string(), revision: v.number() });
const resultValidator = v.object({
  kind: kindValidator,
  status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("blocked")),
  lastCheckAt: v.number(),
  lastSuccessAt: v.union(v.number(), v.null()),
  errorCategory: v.union(v.string(), v.null()),
  guidance: v.union(v.string(), v.null()),
  capabilities: v.array(v.string()),
  catalogObservedAt: v.union(v.number(), v.null()),
});
type PersistedConnection = {
  kind: "linear" | "t3";
  status: "connected" | "disconnected" | "blocked";
  lastCheckAt: number;
  lastSuccessAt: number | null;
  errorCategory: string | null;
  guidance: string | null;
  capabilities: string[];
  catalogObservedAt: number | null;
};
type CheckActionResult = PersistedConnection | { kind: "linear" | "t3"; status: "blocked"; errorCategory: string; guidance: string };

/** Begins a durable generation before any external operation. */
export const reserveCheck = internalMutation({
  args: { kind: kindValidator, ownerGrant: grantValidator },
  returns: v.union(v.object({ generation: v.number(), projectId: v.id("projectMappings"), mapping: v.object({ repository: v.string(), linearProjectId: v.string(), t3EnvironmentId: v.string(), t3ProjectId: v.string(), baseRef: v.string() }) }), v.null()),
  handler: async (ctx, args) => {
    const { requireCurrentOwnerGrant } = await import("./lib/auth");
    await requireCurrentOwnerGrant(ctx, args.ownerGrant);
    const projects = await ctx.db.query("projectMappings").withIndex("by_singleton", (q) => q.eq("singletonKey", "helm")).take(2);
    if (projects.length !== 1) return null;
    const project = projects[0]!;
    const prior = await ctx.db.query("serviceConnections").withIndex("by_project_and_kind", (q) => q.eq("projectId", project._id).eq("kind", args.kind)).take(2);
    if (prior.length > 1) return null;
    const previous = prior[0];
    const generation = (previous?.generation ?? 0) + 1;
    const configuredIdentity = args.kind === "linear" ? project.linearProjectId : `${project.t3EnvironmentId}/${project.t3ProjectId}`;
    const values = {
      projectId: project._id,
      kind: args.kind,
      configuredIdentity,
      status: "blocked" as const,
      generation,
      lastCheckAt: Date.now(),
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      errorCategory: "check_in_progress",
      guidance: "The connection check has not completed; run a fresh check before relying on this service.",
      capabilities: previous?.capabilities ?? [],
      catalogObservedAt: previous?.catalogObservedAt ?? null,
    };
    if (previous) await ctx.db.patch(previous._id, values);
    else await ctx.db.insert("serviceConnections", values);
    return {
      generation,
      projectId: project._id,
      mapping: {
        repository: project.repository,
        linearProjectId: project.linearProjectId,
        t3EnvironmentId: project.t3EnvironmentId,
        t3ProjectId: project.t3ProjectId,
        baseRef: project.baseRef,
      },
    };
  },
});

/** Persists only the newest result and revalidates the grant in the same transaction. */
export const finishCheck = internalMutation({
  args: {
    kind: kindValidator,
    generation: v.number(),
    ownerGrant: grantValidator,
    result: v.object({ ok: v.boolean(), category: v.union(v.string(), v.null()), capabilities: v.array(v.string()), catalogObservedAt: v.union(v.number(), v.null()) }),
  },
  returns: v.union(resultValidator, v.null()),
  handler: async (ctx, args) => {
    const { requireCurrentOwnerGrant } = await import("./lib/auth");
    await requireCurrentOwnerGrant(ctx, args.ownerGrant);
    const project = await ctx.db.query("projectMappings").withIndex("by_singleton", (q) => q.eq("singletonKey", "helm")).unique();
    if (!project) return null;
    const row = await ctx.db.query("serviceConnections").withIndex("by_project_and_kind", (q) => q.eq("projectId", project._id).eq("kind", args.kind)).unique();
    if (!row || row.generation !== args.generation) return null;
    const validCategories = new Set(["missing_config", "unauthorized", "transport", "timeout", "wrong_identity", "unsupported_response"]);
    const category = args.result.ok ? null : validCategories.has(args.result.category ?? "") ? args.result.category : "unknown";
    const status = args.result.ok ? "connected" : category === "missing_config" || category === "wrong_identity" || category === "unsupported_response" ? "blocked" : "disconnected";
    const errorKind: ConnectionErrorKind = category === "unauthorized" || category === "transport" || category === "timeout" || category === "missing_config" ? category : "unknown";
    const classified = category === null ? null : classifyConnectionError(errorKind);
    const guidance = category === "wrong_identity"
      ? "The responding service does not match the trusted project and environment mapping. Correct the server-side mapping before dispatch."
      : category === "unsupported_response"
        ? "The service responded in an unsupported format; identity was not verified, so dispatch remains blocked."
        : classified?.guidance ?? null;
    await ctx.db.patch(row._id, {
      status: status as PersistedConnection["status"],
      lastCheckAt: Date.now(),
      lastSuccessAt: args.result.ok ? Date.now() : row.lastSuccessAt,
      errorCategory: category,
      guidance,
      capabilities: args.result.ok ? args.result.capabilities.slice(0, 50) : row.capabilities,
      catalogObservedAt: args.result.ok ? args.result.catalogObservedAt : row.catalogObservedAt,
    });
    return {
      kind: row.kind,
      status: status as PersistedConnection["status"],
      lastCheckAt: Date.now(),
      lastSuccessAt: args.result.ok ? Date.now() : row.lastSuccessAt,
      errorCategory: category,
      guidance,
      capabilities: args.result.ok ? args.result.capabilities.slice(0, 50) : row.capabilities,
      catalogObservedAt: args.result.ok ? args.result.catalogObservedAt : row.catalogObservedAt,
    };
  },
});

/** Owner-authorized, read-only service check. No browser input selects a target or credential. */
export const check = action({
  args: { kind: kindValidator },
  returns: v.union(resultValidator, v.object({ kind: kindValidator, status: v.literal("blocked"), errorCategory: v.string(), guidance: v.string() })),
  handler: async (ctx, args): Promise<CheckActionResult> => {
    const identity = await ctx.auth.getUserIdentity();
    const subject = process.env.HELM_OWNER_SUBJECT;
    const issuer = process.env.CLERK_FRONTEND_API_URL;
    if (!identity || !subject || !issuer || identity.subject !== subject || identity.issuer !== issuer || identity.tokenIdentifier !== `${issuer}|${subject}`) {
      throw new Error("unauthorized: owner access required");
    }
    const revision = await ctx.runQuery(internal.auth.activeGrantRevision, { subject, issuer });
    if (revision === null) throw new Error("unauthorized: no active owner grant");
    const ownerGrant = { subject, issuer, revision };
    const reservation = await ctx.runMutation(internal.connections.reserveCheck, { kind: args.kind, ownerGrant });
    if (!reservation) return { kind: args.kind, status: "blocked" as const, errorCategory: "missing_mapping", guidance: "Configure one valid trusted project mapping from deployment environment before checking services." };
    await ctx.runQuery(internal.auth.assertCurrentGrant, ownerGrant);
    let result: AdapterResult;
    if (args.kind === "linear") {
      result = await verifyLinearProject({ projectId: reservation.mapping.linearProjectId, apiKey: process.env.LINEAR_API_KEY ?? "" });
    } else {
      const config = resolveIsolatedDispatchConfig();
      if (!config.ok || process.env.T3_ENVIRONMENT_ID?.trim() !== reservation.mapping.t3EnvironmentId || process.env.T3_PROJECT_ID_ISOLATED?.trim() !== reservation.mapping.t3ProjectId) {
        result = { ok: false, category: config.ok ? "wrong_identity" : config.failure.includes("not_configured") ? "missing_config" : "unsupported_response", capabilities: [], catalogObservedAt: null };
      } else {
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), { requestInit: { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15_000) } });
        const client = new Client({ name: "helm-connections", version: "0.1.0" }, { capabilities: {} });
        try {
          await ctx.runQuery(internal.auth.assertCurrentGrant, ownerGrant);
          await client.connect(transport);
          result = await verifyT3Project({
            environmentId: reservation.mapping.t3EnvironmentId,
            projectId: reservation.mapping.t3ProjectId,
            callTool: async (name, toolArgs) => {
              await ctx.runQuery(internal.auth.assertCurrentGrant, ownerGrant);
              return await client.callTool({ name, arguments: toolArgs });
            },
          });
        } catch (error) {
          result = { ok: false, category: error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? "timeout" : "transport", capabilities: [], catalogObservedAt: null };
        } finally {
          await client.close().catch(() => undefined);
        }
      }
    }
    await ctx.runQuery(internal.auth.assertCurrentGrant, ownerGrant);
    const saved = await ctx.runMutation(internal.connections.finishCheck, { kind: args.kind, generation: reservation.generation, ownerGrant, result });
    return saved ?? { kind: args.kind, status: "blocked", errorCategory: "stale_result", guidance: "A newer connection check completed first; review the latest stored result." };
  },
});
