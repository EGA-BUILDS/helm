import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireCurrentOwnerGrant, requireOwner } from "./lib/auth";

/**
 * Read the grant rows for a subject, distinguishing "absent" from "ambiguous".
 *
 * `grantOwner` cannot use an idempotent "insert if absent": Convex generates the
 * document id, so two concurrent cold-start calls can both observe "no row" and
 * both insert, leaving a duplicate ledger. Reads therefore treat any count other
 * than exactly one as an explicit DENIAL (see `loadSingleGrant` in lib/auth.ts),
 * and `repairOwnerGrants` heals such a ledger. A duplicate can never grant a
 * second owner or widen authority.
 *
 * `grantOwner` must NOT treat "ambiguous" as "absent": doing so would insert a
 * third row into an already-duplicated ledger. It is a distinct outcome here.
 */
async function readGrantRows(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  subject: string,
): Promise<{ kind: "absent" } | { kind: "ambiguous" } | { kind: "one"; grant: NonNullable<Awaited<ReturnType<typeof grantFor>>> }> {
  const rows = await ctx.db
    .query("ownerGrants")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .take(2);
  if (rows.length === 0) return { kind: "absent" };
  if (rows.length > 1) return { kind: "ambiguous" };
  return { kind: "one", grant: grantFor(rows[0]!) };
}

/** The grant shape callers of this module work with. */
function grantFor(row: {
  _id: import("./_generated/dataModel").Id<"ownerGrants">;
  issuer: string;
  revision: number;
  revokedAt: number | null;
}) {
  return row;
}

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
      args.issuer !== process.env.CLERK_FRONTEND_API_URL ||
      !args.subject ||
      !args.issuer
    ) {
      throw new Error("Owner grant must match configured issuer and subject");
    }

    const existing = await readGrantRows(ctx, args.subject);
    if (existing.kind === "ambiguous") {
      // Refuse to write into a duplicated ledger rather than adding a third row.
      throw new ConvexError(
        "unauthorized: owner grant ledger is ambiguous; run internal.auth.repairOwnerGrants",
      );
    }
    const current = existing.kind === "one" ? existing.grant : null;
    const revision = current ? current.revision + 1 : 1;
    if (current) {
      await ctx.db.patch(current._id, {
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

/**
 * Collapse a duplicate grant ledger.
 *
 * A duplicate can only arise from two concurrent cold-start bootstrap calls,
 * because Convex generates the document id and an insert cannot be made
 * idempotent. While a duplicate exists, EVERY read of owner authority is denied
 * (fail closed), so the ledger is self-locking — but that is total denial rather
 * than a working owner session. This mutation heals it by keeping the
 * highest-revision row and deleting the rest, selecting on an explicit rule
 * rather than on index order.
 *
 * It is internal, gated on the configured owner identity, and never grants
 * authority that did not already exist: the surviving row is one of the rows the
 * ledger already contained.
 */
export const repairOwnerGrants = internalMutation({
  args: { subject: v.string() },
  returns: v.object({ repaired: v.boolean(), survivingRevision: v.number(), removed: v.number() }),
  handler: async (ctx, args) => {
    if (!args.subject || args.subject !== process.env.HELM_OWNER_SUBJECT) {
      throw new Error("Cannot repair an unconfigured owner subject");
    }
    const rows = await ctx.db
      .query("ownerGrants")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .take(1000);
    if (rows.length <= 1) {
      return {
        repaired: false,
        survivingRevision: rows[0]?.revision ?? 0,
        removed: 0,
      };
    }
    // Deterministic survivor: highest revision, then earliest grantedAt, then
    // lowest creation time. Never index order, which is not a guarantee.
    const sorted = [...rows].sort((a, b) => {
      if (a.revision !== b.revision) return b.revision - a.revision;
      if (a.grantedAt !== b.grantedAt) return a.grantedAt - b.grantedAt;
      return a._creationTime - b._creationTime;
    });
    const survivor = sorted[0]!;
    for (const row of sorted.slice(1)) {
      await ctx.db.delete(row._id);
    }
    return { repaired: true, survivingRevision: survivor.revision, removed: sorted.length - 1 };
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
    const existing = await readGrantRows(ctx, args.subject);
    // An ambiguous ledger has nothing unambiguous to revoke. Every read path
    // already denies on ambiguity, so authority is already unavailable and the
    // repair path is the correct next step.
    if (existing.kind !== "one") return { revoked: false, revision: null };
    const grant = existing.grant;
    if (grant.revokedAt !== null) return { revoked: false, revision: null };
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
      args.issuer !== process.env.CLERK_FRONTEND_API_URL
    ) return null;
    // Fail closed on an ambiguous ledger: null means no unambiguous authority.
    const existing = await readGrantRows(ctx, args.subject);
    if (existing.kind !== "one") return null;
    const grant = existing.grant;
    if (grant.issuer !== args.issuer || grant.revokedAt !== null) return null;
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
