import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Credential lifetime tracking (EGA-677 task 4, hardened).
 *
 * Credential state is internal. `canDispatch` and `listCredentials` were public
 * queries, which exposed credential scope/expiry/failure state to any client.
 * Reactivating a credential must only happen through a genuine re-authorization.
 *
 * Records metadata about external credentials so dispatch can PAUSE on auth
 * failure instead of retrying into a wall.
 *
 * Why pause rather than retry: the EGA-677 probe against the live T3 endpoint
 * showed that expired, revoked, garbage, empty-bearer, missing-header and
 * wrong-scheme credentials ALL return the single tag `invalid_mcp_credential`.
 * There is no wire signal that separates a retryable error from one that needs
 * the owner to reauthorize, so every auth failure is treated as
 * reauthorization-required.
 *
 * The credential value is NEVER stored here. Only metadata.
 */

export type CredentialStatus = "active" | "paused" | "reauthorizationRequired";

/** Statuses that permit dispatch. */
const DISPATCHABLE: ReadonlySet<CredentialStatus> = new Set<CredentialStatus>(["active"]);

export const recordCredential = internalMutation({
  args: {
    provider: v.string(),
    scopes: v.array(v.string()),
    issuedAt: v.number(),
    expiresAt: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .first();
    if (existing) {
      // A fresh issuance clears any prior failure: the owner reauthorized.
      await ctx.db.patch(existing._id, {
        scopes: args.scopes,
        issuedAt: args.issuedAt,
        expiresAt: args.expiresAt,
        status: "active" as const,
        lastFailureAt: null,
        lastFailureClass: null,
        consecutiveFailures: 0,
      });
      return;
    }
    await ctx.db.insert("credentials", {
      provider: args.provider,
      scopes: args.scopes,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
      status: "active" as const,
      lastVerifiedAt: null,
      lastFailureAt: null,
      lastFailureClass: null,
      consecutiveFailures: 0,
    });
  },
});

export const recordAuthSuccess = internalMutation({
  args: { provider: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      lastVerifiedAt: args.at,
      consecutiveFailures: 0,
    });
  },
});

/**
 * Record an auth failure. Any failure pauses dispatch for that provider.
 * Repeating a failure never escalates to an automatic retry: it stays paused
 * until the owner reauthorizes.
 */
export const recordAuthFailure = internalMutation({
  args: {
    provider: v.string(),
    at: v.number(),
    failureClass: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .first();
    if (!row) {
      await ctx.db.insert("credentials", {
        provider: args.provider,
        scopes: [],
        issuedAt: args.at,
        expiresAt: null,
        status: "reauthorizationRequired" as const,
        lastVerifiedAt: null,
        lastFailureAt: args.at,
        lastFailureClass: args.failureClass,
        consecutiveFailures: 1,
        note: args.note,
      });
      return;
    }
    await ctx.db.patch(row._id, {
      status: "reauthorizationRequired" as const,
      lastFailureAt: args.at,
      lastFailureClass: args.failureClass,
      consecutiveFailures: (row.consecutiveFailures ?? 0) + 1,
      note: args.note ?? row.note,
    });
  },
});

/**
 * Dispatch gate. Returns whether the provider may be used.
 *
 * `reason` is populated when blocked so a caller never sees a bare false.
 */
export const canDispatch = internalQuery({
  args: { provider: v.string() },
  returns: v.object({
    allowed: v.boolean(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("reauthorizationRequired"),
      v.literal("expired"),
      v.literal("unknown"),
    ),
    reason: v.union(v.string(), v.null()),
    expiresAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .first();
    if (!row) {
      return {
        allowed: false,
        status: "unknown" as const,
        reason: `no credential recorded for ${args.provider}`,
        expiresAt: null,
      };
    }
    const status = row.status as CredentialStatus;
    if (!DISPATCHABLE.has(status)) {
      return {
        allowed: false,
        status,
        reason:
          status === "reauthorizationRequired"
            ? `owner reauthorization required for ${args.provider} (last failure: ${row.lastFailureClass ?? "unknown"})`
            : `dispatch paused for ${args.provider}`,
        expiresAt: row.expiresAt,
      };
    }
    // An `active` status alone is not authority to dispatch: the declared
    // lifetime is part of the gate. A credential that has passed its expiry
    // fails closed with its own status rather than being treated as usable.
    // (The T3 endpoint reports every auth failure with the single
    // `invalid_mcp_credential` tag, so expiry cannot be distinguished on the
    // wire — which is exactly why it must be enforced HERE, before the call.)
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      return {
        allowed: false,
        status: "expired" as const,
        reason: `credential for ${args.provider} expired at ${row.expiresAt}; reauthorize before dispatch`,
        expiresAt: row.expiresAt,
      };
    }
    return { allowed: true, status, reason: null, expiresAt: row.expiresAt };
  },
});

/** Credential metadata for operators. Never returns a secret. */
export const listCredentials = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      provider: v.string(),
      status: v.string(),
      scopes: v.array(v.string()),
      issuedAt: v.number(),
      expiresAt: v.union(v.number(), v.null()),
      lastVerifiedAt: v.union(v.number(), v.null()),
      lastFailureAt: v.union(v.number(), v.null()),
      lastFailureClass: v.union(v.string(), v.null()),
      consecutiveFailures: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("credentials").collect();
    return rows.map((r) => ({
      provider: r.provider,
      status: r.status,
      scopes: r.scopes,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      lastVerifiedAt: r.lastVerifiedAt,
      lastFailureAt: r.lastFailureAt,
      lastFailureClass: r.lastFailureClass,
      consecutiveFailures: r.consecutiveFailures,
    }));
  },
});