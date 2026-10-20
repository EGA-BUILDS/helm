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

// Typed result shapes. These are exactly the store handlers' return objects
// (no fields added, none removed), so tightening the validators cannot change
// the response shape: the validator now REJECTS malformed responses instead of
// letting v.any() pass them through.
const writeResultValidator = v.object({ associationId: v.string(), created: v.boolean() });
const unlinkResultValidator = v.object({
  removed: v.boolean(),
  deleted: v.boolean(),
  unlinked: v.boolean(),
  associationId: v.union(v.string(), v.null()),
});
const associationValidator = v.object({
  association: v.union(
    v.object({
      associationId: v.string(),
      linearWorkspaceId: v.string(),
      linearProjectId: v.string(),
      linearTeamId: v.string(),
      linearIssueId: v.string(),
      linearIssueIdentifier: v.string(),
      t3ConnectionId: v.string(),
      t3EnvironmentId: v.string(),
      t3ProjectId: v.string(),
      t3ThreadId: v.string(),
      attemptId: v.string(),
      correlationKey: v.string(),
      unlinkedAt: v.number(),
      createdAt: v.number(),
      note: v.optional(v.string()),
      provenance: v.union(v.literal("manual"), v.literal("launch")),
      /**
       * The binding's real sync state, so the owner-facing panel never has to
       * claim "linked" for a launch-derived binding whose state is pending or
       * synced.
       */
      ledgerState: v.optional(v.string()),
    }),
    v.null(),
  ),
});

export const link = action({
  args: linkArgs,
  returns: writeResultValidator,
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "link", args as Record<string, unknown>) as { associationId: string; created: boolean };
  },
});

export const unlink = action({
  args: linkArgs,
  returns: unlinkResultValidator,
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "unlink", args as Record<string, unknown>) as { removed: boolean; deleted: boolean; unlinked: boolean; associationId: string | null };
  },
});

export const reassign = action({
  args: linkArgs,
  returns: writeResultValidator,
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    return await runStore(ctx, owner, "reassign", args as Record<string, unknown>) as { associationId: string; created: boolean };
  },
});

export const readAssociation = action({
  args: {
    connectionId: v.string(),
    projectId: v.string(),
    threadId: v.string(),
  },
  returns: associationValidator,
  handler: async (ctx, args) => {
    const owner: Owner = await ctx.runQuery(internal.linearManualLinkStore.ownerContext, {});
    await ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const association = await ctx.runQuery(internal.linearManualLinkStore.readAssociation, {
      ...storeOwner(owner),
      connectionId: args.connectionId,
      projectId: args.projectId,
      threadId: args.threadId,
    }) as { associationId: string; linearWorkspaceId: string; linearProjectId: string; linearTeamId: string; linearIssueId: string; linearIssueIdentifier: string; t3ConnectionId: string; t3EnvironmentId: string; t3ProjectId: string; t3ThreadId: string; attemptId: string; correlationKey: string; unlinkedAt: number; createdAt: number; note?: string; provenance: "manual" | "launch" } | null;
    return { association };
  },
});
