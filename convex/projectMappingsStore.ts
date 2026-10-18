import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireCurrentOwnerGrant, requireOwner, type OwnerIdentity } from "./lib/auth";

const ownerArgs = { subject: v.string(), ownerIssuer: v.string(), revision: v.number() };

export const ownerContext = internalQuery({
  args: {},
  returns: v.object({ subject: v.string(), issuer: v.string(), revision: v.number() }),
  handler: async (ctx): Promise<OwnerIdentity> => requireOwner(ctx),
});

const mappingFields = {
  linearWorkspaceId: v.string(),
  linearProjectId: v.string(),
  linearProjectName: v.string(),
  linearTeamId: v.string(),
  linearTeamKey: v.string(),
  linearTeamName: v.string(),
  t3ConnectionId: v.id("t3Connections"),
  t3EnvironmentId: v.string(),
  t3ProjectId: v.string(),
  t3ProjectTitle: v.string(),
  worktreeBaseRef: v.string(),
  targetBranch: v.string(),
  startedStateId: v.string(),
  startedStateName: v.string(),
};

const mappingView = v.object({
  ...mappingFields,
  mappingId: v.id("linearProjectMappings"),
  enabled: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function requiredText(value: string, label: string, max: number): string {
  if (value.trim().length === 0 || value.length > max) throw new Error(label);
  return value;
}

function checkSaveArgs(args: {
  linearWorkspaceId: string;
  linearProjectId: string;
  linearProjectName: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ProjectTitle: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
  startedStateName: string;
}): void {
  requiredText(args.linearWorkspaceId, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.linearProjectId, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.linearProjectName, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.linearTeamId, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.linearTeamKey, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.linearTeamName, "Linear project mapping is missing its Linear destination", 1024);
  requiredText(args.t3EnvironmentId, "Linear project mapping is missing its T3 destination", 1024);
  requiredText(args.t3ProjectId, "Linear project mapping is missing its T3 destination", 1024);
  requiredText(args.t3ProjectTitle, "Linear project mapping is missing its T3 destination", 1024);
  // baseRef and targetBranch are separate concepts with separate errors: a
  // missing branch must never read as a missing baseRef or vice versa.
  requiredText(args.worktreeBaseRef, "Linear project mapping is missing its worktree baseRef", 512);
  requiredText(args.targetBranch, "Linear project mapping is missing its PR target branch", 512);
  requiredText(args.startedStateId, "Linear project mapping is missing its started workflow state", 1024);
  requiredText(args.startedStateName, "Linear project mapping is missing its started workflow state", 1024);
}

function toView(row: {
  _id: import("./_generated/dataModel").Id<"linearProjectMappings">;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearProjectName: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  t3ConnectionId: import("./_generated/dataModel").Id<"t3Connections">;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ProjectTitle: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
  startedStateName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    mappingId: row._id,
    linearWorkspaceId: row.linearWorkspaceId,
    linearProjectId: row.linearProjectId,
    linearProjectName: row.linearProjectName,
    linearTeamId: row.linearTeamId,
    linearTeamKey: row.linearTeamKey,
    linearTeamName: row.linearTeamName,
    t3ConnectionId: row.t3ConnectionId,
    t3EnvironmentId: row.t3EnvironmentId,
    t3ProjectId: row.t3ProjectId,
    t3ProjectTitle: row.t3ProjectTitle,
    worktreeBaseRef: row.worktreeBaseRef,
    targetBranch: row.targetBranch,
    startedStateId: row.startedStateId,
    startedStateName: row.startedStateName,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const listMappings = internalQuery({
  args: { ...ownerArgs },
  returns: v.array(mappingView),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearProjectMappings")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("mapping inventory exceeds the supported limit");
    return rows.map(toView);
  },
});

export const getMapping = internalQuery({
  args: { ...ownerArgs, mappingId: v.id("linearProjectMappings") },
  returns: v.union(mappingView, v.null()),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.mappingId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) return null;
    return toView(row);
  },
});

/**
 * Resolve the enabled mapping for an issue's (project, team) pair. Disabled
 * mappings never resolve: a disabled mapping must not dispatch, and the row
 * itself (plus any historic references to it) is left untouched.
 */
export const resolveMappingForIssue = internalQuery({
  args: { ...ownerArgs, linearProjectId: v.string(), linearTeamId: v.string() },
  returns: v.union(mappingView, v.null()),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearProjectMappings")
      .withIndex("by_owner_project_team", (q) =>
        q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer)
          .eq("linearProjectId", args.linearProjectId).eq("linearTeamId", args.linearTeamId))
      .take(3);
    const enabled = rows.filter((row) => row.enabled);
    if (enabled.length > 1) throw new Error("mapping identity is ambiguous");
    if (enabled.length === 0) return null;
    return toView(enabled[0]!);
  },
});

/**
 * Resolve the enabled mappings for one Linear project. Disabled mappings never
 * resolve: a disabled mapping must not browse, and the row itself (plus any
 * historic references to it) is left untouched. Additive for EGA-680; the
 * existing `resolveMappingForIssue` contract is unchanged.
 */
export const enabledMappingsForProject = internalQuery({
  args: { ...ownerArgs, linearProjectId: v.string() },
  returns: v.array(mappingView),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db
      .query("linearProjectMappings")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("mapping inventory exceeds the supported limit");
    return rows.filter((row) => row.linearProjectId === args.linearProjectId && row.enabled).map(toView);
  },
});

export const saveMapping = internalMutation({
  args: {
    ...ownerArgs,
    mappingId: v.optional(v.id("linearProjectMappings")),
    ...mappingFields,
    at: v.number(),
  },
  returns: v.id("linearProjectMappings"),
  handler: async (ctx, args) => {
    const { subject, ownerIssuer, revision, mappingId, at, ...fields } = args;
    const owner = { subject, issuer: ownerIssuer, revision };
    await requireCurrentOwnerGrant(ctx, owner);
    checkSaveArgs(args);
    const siblings = await ctx.db
      .query("linearProjectMappings")
      .withIndex("by_owner_project_team", (q) =>
        q.eq("ownerSubject", subject).eq("ownerIssuer", ownerIssuer)
          .eq("linearProjectId", args.linearProjectId).eq("linearTeamId", args.linearTeamId))
      .take(3);
    if (mappingId) {
      const row = await ctx.db.get(mappingId);
      if (!row || row.ownerSubject !== subject || row.ownerIssuer !== ownerIssuer) {
        throw new Error("Project mapping is unavailable");
      }
      // One enabled mapping per (owner, project, team): another enabled row
      // already holding this pair rejects the edit, so an edit can never
      // create a duplicate by moving onto an occupied pair.
      if (siblings.some((sibling) => sibling._id !== mappingId && sibling.enabled)) {
        throw new Error("A mapping for this Linear project and team already exists");
      }
      await ctx.db.patch(row._id, {
        ...fields,
        ownerSubject: subject,
        ownerRevision: revision,
        updatedAt: at,
      });
      return row._id;
    }
    if (siblings.some((sibling) => sibling.enabled)) {
      throw new Error("A mapping for this Linear project and team already exists");
    }
    if (siblings.length > 50) throw new Error("mapping inventory exceeds the supported limit");
    return await ctx.db.insert("linearProjectMappings", {
      ...fields,
      ownerSubject: subject,
      ownerIssuer,
      ownerRevision: revision,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    });
  },
});

/**
 * Disable a mapping. The row — and every identifier on it — stays intact, so
 * prior execution history that references the mapping is never rewritten; only
 * `enabled` flips and `resolveMappingForIssue` stops returning it.
 */
export const disableMapping = internalMutation({
  args: { ...ownerArgs, mappingId: v.id("linearProjectMappings"), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.mappingId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) return false;
    if (row.enabled) await ctx.db.patch(row._id, { enabled: false, updatedAt: args.at });
    else await ctx.db.patch(row._id, { updatedAt: args.at });
    return true;
  },
});
