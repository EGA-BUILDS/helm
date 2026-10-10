import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { selectSingleMapping, targetMappingFromEnv } from "./lib/targets";
import { requireOwner } from "./lib/auth";

const targetFields = {
  repository: v.string(),
  linearProjectId: v.string(),
  t3EnvironmentId: v.string(),
  t3ProjectId: v.string(),
  baseRef: v.string(),
};

/** Deployment tooling only: validates and persists the configured mapping. */
export const seedFromEnvironment = internalAction({
  args: {},
  returns: v.object({ configured: v.boolean(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx) => {
    const environment: Record<string, string | undefined> = process.env;
    const validation = targetMappingFromEnv(environment);
    if (!validation.ok) {
      return { configured: false, error: validation.issues.map((issue) => `${issue.field ?? "mapping"}:${issue.code}`).join(",") };
    }
    const ownerSubject = process.env.HELM_OWNER_SUBJECT?.trim();
    if (!ownerSubject) return { configured: false, error: "owner_subject:missing" };
    await ctx.runMutation(internal.projects.upsertTrustedMapping, {
      ...validation.mapping,
      ownerSubject,
    });
    return { configured: true, error: null };
  },
});

export const upsertTrustedMapping = internalMutation({
  args: { ...targetFields, ownerSubject: v.string() },
  returns: v.id("projectMappings"),
  handler: async (ctx, args) => {
    const validation = selectSingleMapping([args]);
    if (!validation.ok) throw new Error("project mapping is invalid");
    if (!args.ownerSubject || args.ownerSubject !== process.env.HELM_OWNER_SUBJECT) {
      throw new Error("project mapping owner does not match deployment configuration");
    }
    const existing = await ctx.db.query("projectMappings").withIndex("by_singleton", (q) => q.eq("singletonKey", "helm")).take(2);
    if (existing.length > 1) throw new Error("project mapping ledger is ambiguous");
    const values = { ...validation.mapping, ownerSubject: args.ownerSubject, source: "deployment_environment" as const, updatedAt: Date.now() };
    if (existing[0]) {
      const previous = existing[0];
      const changed = previous.ownerSubject !== args.ownerSubject ||
        previous.repository !== values.repository || previous.linearProjectId !== values.linearProjectId ||
        previous.t3EnvironmentId !== values.t3EnvironmentId || previous.t3ProjectId !== values.t3ProjectId ||
        previous.baseRef !== values.baseRef;
      if (changed) {
        const connections = await ctx.db.query("serviceConnections").withIndex("by_project", (q) => q.eq("projectId", previous._id)).take(3);
        const now = Date.now();
        for (const connection of connections) {
          const configuredIdentity = connection.kind === "linear" ? values.linearProjectId : `${values.t3EnvironmentId}/${values.t3ProjectId}`;
          await ctx.db.patch(connection._id, {
            configuredIdentity,
            status: "blocked",
            generation: connection.generation + 1,
            lastCheckAt: now,
            lastSuccessAt: null,
            errorCategory: "configuration_changed",
            guidance: "The trusted project configuration changed. Recheck this service before relying on its status.",
            capabilities: [],
            catalogObservedAt: null,
          });
        }
      }
      await ctx.db.replace(existing[0]._id, { singletonKey: "helm", ...values });
      return existing[0]._id;
    }
    return await ctx.db.insert("projectMappings", { singletonKey: "helm", ...values });
  },
});

export const trustedTarget = internalQuery({
  args: {},
  returns: v.union(v.object({
    id: v.id("projectMappings"),
    ...targetFields,
    t3Status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("blocked"), v.null()),
    t3LastCheckAt: v.union(v.number(), v.null()),
  }), v.null()),
  handler: async (ctx) => {
    const rows = await ctx.db.query("projectMappings").withIndex("by_singleton", (q) => q.eq("singletonKey", "helm")).take(2);
    const validation = selectSingleMapping(rows);
    if (!validation.ok) return null;
    const connectionRows = await ctx.db.query("serviceConnections").withIndex("by_project_and_kind", (q) => q.eq("projectId", rows[0]!._id).eq("kind", "t3")).take(2);
    if (connectionRows.length > 1) return null;
    const expectedIdentity = `${validation.mapping.t3EnvironmentId}/${validation.mapping.t3ProjectId}`;
    const connection = connectionRows[0];
    return {
      id: rows[0]!._id,
      ...validation.mapping,
      t3Status: connection?.configuredIdentity === expectedIdentity ? connection.status : null,
      t3LastCheckAt: connection?.configuredIdentity === expectedIdentity ? connection.lastCheckAt : null,
    };
  },
});

/** Owner-only view; contains target identity and sanitized connection state only. */
export const getOverview = query({
  args: {},
  returns: v.object({
    project: v.union(v.object({ ...targetFields }), v.null()),
    connections: v.array(v.object({
      kind: v.union(v.literal("linear"), v.literal("t3")),
      configuredIdentity: v.string(),
      status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("blocked")),
      lastCheckAt: v.number(),
      lastSuccessAt: v.union(v.number(), v.null()),
      errorCategory: v.union(v.string(), v.null()),
      guidance: v.union(v.string(), v.null()),
      capabilities: v.array(v.string()),
      catalogObservedAt: v.union(v.number(), v.null()),
    })),
  }),
  handler: async (ctx) => {
    await requireOwner(ctx);
    const rows = await ctx.db.query("projectMappings").withIndex("by_singleton", (q) => q.eq("singletonKey", "helm")).take(2);
    const validation = selectSingleMapping(rows);
    if (!validation.ok || rows.length !== 1) return { project: null, connections: [] };
    const connections = await ctx.db.query("serviceConnections").withIndex("by_project", (q) => q.eq("projectId", rows[0]!._id)).take(3);
    return {
      project: validation.mapping,
      connections: connections.map(({ kind, configuredIdentity, status, lastCheckAt, lastSuccessAt, errorCategory, guidance, capabilities, catalogObservedAt }) => ({ kind, configuredIdentity, status, lastCheckAt, lastSuccessAt, errorCategory, guidance, capabilities, catalogObservedAt })),
    };
  },
});
