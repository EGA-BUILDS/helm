import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type OwnerAuthCtx = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;
type GrantCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export interface OwnerIdentity {
  subject: string;
  issuer: string;
  revision: number;
}

function deny(reason: string): never {
  throw new ConvexError(`unauthorized: ${reason}`);
}

function configuredOwner(): { subject: string; issuer: string } {
  const subject = process.env.HELM_OWNER_SUBJECT;
  const issuer = process.env.CLERK_FRONTEND_API_URL;
  if (!subject || !issuer) deny("owner authorization is not configured");
  return { subject, issuer };
}

/**
 * Require a Clerk identity whose verified issuer and immutable subject match
 * server configuration and whose explicit, current grant is active.
 */
export async function requireOwner(ctx: OwnerAuthCtx): Promise<OwnerIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) deny("no authenticated identity");

  const expected = configuredOwner();
  if (identity.issuer !== expected.issuer) deny("untrusted issuer");
  if (identity.subject !== expected.subject) deny("unknown subject");
  // Fail closed on the canonical stable identity key as well: subject and
  // issuer matching individually is not enough if the token identifier —
  // `${issuer}|${subject}` — does not bind them together.
  if (identity.tokenIdentifier !== `${expected.issuer}|${expected.subject}`) {
    deny("token identity mismatch");
  }

  const grant = await ctx.db
    .query("ownerGrants")
    .withIndex("by_subject", (q) => q.eq("subject", expected.subject))
    .unique();
  if (!grant || grant.issuer !== expected.issuer || grant.revokedAt !== null) {
    deny("no active owner grant");
  }

  return { subject: expected.subject, issuer: expected.issuer, revision: grant.revision };
}

/**
 * Recheck durable authority for an internal/background job. Scheduled work
 * has no browser identity; it must present the subject, issuer and revision
 * captured when it was queued, and the current grant must still match all 3.
 */
export async function requireCurrentOwnerGrant(
  ctx: GrantCtx,
  expected: OwnerIdentity,
): Promise<void> {
  const configured = configuredOwner();
  if (expected.subject !== configured.subject || expected.issuer !== configured.issuer) {
    deny("owner configuration changed");
  }

  const grant = await ctx.db
    .query("ownerGrants")
    .withIndex("by_subject", (q) => q.eq("subject", expected.subject))
    .unique();
  if (
    !grant ||
    grant.issuer !== expected.issuer ||
    grant.revokedAt !== null ||
    grant.revision !== expected.revision
  ) {
    deny("owner grant is missing, revoked, or stale");
  }
}
