import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireCurrentOwnerGrant, requireOwner } from "./lib/auth";

/** Minimal owner-only probe. It intentionally returns no identity or secrets. */
export const session = query({
  args: {},
  returns: v.object({
    authorized: v.literal(true),
    application: v.literal("helm"),
    session: v.literal("owner"),
  }),
  handler: async (ctx) => {
    await requireOwner(ctx);
    return { authorized: true as const, application: "helm" as const, session: "owner" as const };
  },
});

/** Explicit internal bootstrap/regrant operation, callable only by trusted server tooling. */
export const grantOwner = internalMutation({
  args: { subject: v.string(), issuer: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    if (
      args.subject !== process.env.HELM_OWNER_SUBJECT ||
      args.issuer !== process.env.CLERK_ISSUER_DOMAIN ||
      !args.subject ||
      !args.issuer
    ) {
      throw new Error("Owner grant must match configured issuer and subject");
    }

    const existing = await ctx.db
      .query("ownerGrants")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    const revision = existing ? existing.revision + 1 : 1;
    if (existing) {
      await ctx.db.patch(existing._id, {
        issuer: args.issuer,
        grantedAt: Date.now(),
        revokedAt: null,
        revision,
      });
    } else {
      await ctx.db.insert("ownerGrants", {
        ...args,
        grantedAt: Date.now(),
        revokedAt: null,
        revision,
      });
    }
    return { revision };
  },
});

/** Internal owner kill switch; authority disappears on the next query/job check. */
export const revokeOwner = internalMutation({
  args: { subject: v.string() },
  returns: v.object({ revoked: v.boolean(), revision: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    if (!args.subject || args.subject !== process.env.HELM_OWNER_SUBJECT) {
      throw new Error("Cannot revoke an unconfigured owner subject");
    }
    const grant = await ctx.db
      .query("ownerGrants")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (!grant || grant.revokedAt !== null) return { revoked: false, revision: null };
    await ctx.db.patch(grant._id, { revokedAt: Date.now() });
    return { revoked: true, revision: grant.revision };
  },
});

/**
 * Internal check for jobs that run without a browser session. A null result is
 * an explicit denial signal; the caller must not infer authentication.
 */
export const activeGrantRevision = internalQuery({
  args: { subject: v.string(), issuer: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    if (
      !args.subject ||
      !args.issuer ||
      args.subject !== process.env.HELM_OWNER_SUBJECT ||
      args.issuer !== process.env.CLERK_ISSUER_DOMAIN
    ) return null;
    const grant = await ctx.db
      .query("ownerGrants")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (!grant || grant.issuer !== args.issuer || grant.revokedAt !== null) return null;
    return grant.revision;
  },
});

/** Background-work guard with no assumption that a browser JWT exists. */
export const assertCurrentGrant = internalQuery({
  args: {
    subject: v.string(),
    issuer: v.string(),
    revision: v.number(),
  },
  returns: v.literal(true),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, args);
    return true as const;
  },
});
