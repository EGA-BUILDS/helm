"use node";

import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";


type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const linkArgs = {
  // Linear side (and aliases)
  linearWorkspaceId: v.optional(v.string()),
  linearProjectId: v.optional(v.string()),
  linearTeamId: v.optional(v.string()),
  linearIssueId: v.optional(v.string()),
  linearIssueIdentifier: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  teamId: v.optional(v.string()),
  issueId: v.optional(v.string()),
  issueIdentifier: v.optional(v.string()),
  // T3 side (and aliases)
  t3ConnectionId: v.optional(v.union(v.id("t3Connections"), v.string())),
  t3EnvironmentId: v.optional(v.string()),
  t3ProjectId: v.optional(v.string()),
  t3ThreadId: v.optional(v.string()),
  connectionId: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  // Mapping selector
  mappingId: v.optional(v.id("linearProjectMappings")),
  linearProjectMappingId: v.optional(v.id("linearProjectMappings")),
  // Control
  confirm: v.optional(v.boolean()),
  confirmed: v.optional(v.boolean()),
  confirmLaunchEvidenceLoss: v.optional(v.boolean()),
  expectedAssociationId: v.optional(v.string()),
  expectedAssociation: v.optional(v.string()),
  currentAssociationId: v.optional(v.string()),
  fromAssociationId: v.optional(v.string()),
  associationId: v.optional(v.string()),
  note: v.optional(v.string()),
  // Optional owner fields (ignored in favor of the resolved identity).
  subject: v.optional(v.string()),
  ownerIssuer: v.optional(v.string()),
  revision: v.optional(v.number()),
};

async function runStore(
  ctx: ActionCtx,
  owner: Owner,
  mutationName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
    subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
  });
  await assertOwnerCurrent();
  const payload = { ...args, ...storeOwner(owner) };
  if (mutationName === "unlink") {
    return await ctx.runMutation(internal.linearManualLinkStore.unlink, payload);
  }
  if (mutationName === "reassign") {
    return await ctx.runMutation(internal.linearManualLinkStore.reassign, payload);
  }
  return await ctx.runMutation(internal.linearManualLinkStore.link, payload);
}

export const link = action({
  args: linkArgs,
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "link", args as Record<string, unknown>);
  },
});

export const unlink = action({
  args: linkArgs,
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "unlink", args as Record<string, unknown>);
  },
});

export const reassign = action({
  args: linkArgs,
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "reassign", args as Record<string, unknown>);
  },
});
