import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireCurrentOwnerGrant, requireOwner, type OwnerIdentity } from "./lib/auth";

const ownerArgs = { subject: v.string(), ownerIssuer: v.string(), revision: v.number() };
export const ownerContext = internalQuery({
  args: {},
  returns: v.object({ subject: v.string(), issuer: v.string(), revision: v.number() }),
  handler: async (ctx): Promise<OwnerIdentity> => requireOwner(ctx),
});

export const createAttempt = internalMutation({
  args: {
    ...ownerArgs,
    attemptId: v.string(), endpoint: v.string(), issuer: v.string(), resource: v.string(),
    authorizationEndpoint: v.string(), tokenEndpoint: v.string(), registrationEndpoint: v.string(),
    clientId: v.string(), redirectUri: v.string(), stateHash: v.string(),
    verifierCiphertext: v.string(), connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
    createdAt: v.number(), expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const previous = await ctx.db.query("t3AuthAttempts")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .order("desc")
      .take(51);
    if (previous.length > 50) throw new Error("OAuth attempt inventory exceeds the supported limit");
    let activeCount = 0;
    for (const row of previous) {
      if (row.status === "connected" || row.status === "denied" || row.status === "expired" || row.status === "failed" ||
          row.ownerRevision !== args.revision ||
          ((row.status === "pending" || row.status === "consuming") && row.expiresAt <= args.createdAt)) {
        await ctx.db.delete(row._id);
        continue;
      }
      activeCount++;
      if (row.endpoint === args.endpoint) throw new Error("A T3 OAuth attempt is already active for this endpoint");
    }
    if (activeCount >= 20) throw new Error("Too many T3 OAuth attempts are active");
    await ctx.db.insert("t3AuthAttempts", {
      ...args, status: "pending", finishedAt: null,
    });
  },
});

export const consumeAttempt = internalMutation({
  args: { ...ownerArgs, stateHash: v.string(), now: v.number() },
  returns: v.union(v.object({
    attemptId: v.string(), endpoint: v.string(), issuer: v.string(), resource: v.string(),
    tokenEndpoint: v.string(), clientId: v.string(), redirectUri: v.string(),
    verifierCiphertext: v.string(), connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const rows = await ctx.db.query("t3AuthAttempts")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash)).take(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status !== "pending") return null;
    if (row.expiresAt <= args.now) {
      await ctx.db.patch(row._id, { status: "expired", finishedAt: args.now });
      return null;
    }
    await ctx.db.patch(row._id, { status: "consuming" });
    return {
      attemptId: row.attemptId, endpoint: row.endpoint, issuer: row.issuer,
      resource: row.resource, tokenEndpoint: row.tokenEndpoint, clientId: row.clientId,
      redirectUri: row.redirectUri, verifierCiphertext: row.verifierCiphertext,
      connectionId: row.connectionId, expectedConnectionCredentialVersion: row.expectedConnectionCredentialVersion,
    };
  },
});

export const finishAttempt = internalMutation({
  args: { ...ownerArgs, attemptId: v.string(), status: v.union(v.literal("connected"), v.literal("denied"), v.literal("expired"), v.literal("failed")), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const row = await ctx.db.query("t3AuthAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId)).unique();
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status !== "consuming") return;
    await ctx.db.patch(row._id, { status: args.status, finishedAt: args.at });
  },
});

export const saveConnection = internalMutation({
  args: {
    ...ownerArgs, attemptId: v.string(), connectionId: v.union(v.string(), v.null()), endpoint: v.string(),
    issuer: v.string(), resource: v.string(), clientId: v.string(), environmentId: v.string(),
    environmentLabel: v.string(), serverVersion: v.string(), platform: v.string(),
    tokenCiphertext: v.string(), expiresAt: v.number(), at: v.number(),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
  },
  returns: v.id("t3Connections"),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const attempt = await ctx.db.query("t3AuthAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId)).unique();
    if (!attempt || attempt.ownerSubject !== args.subject || attempt.ownerIssuer !== args.ownerIssuer ||
        attempt.ownerRevision !== args.revision || attempt.status !== "consuming" || attempt.expiresAt <= args.at) {
      throw new Error("OAuth attempt expired while completing");
    }
    const rows = await ctx.db.query("t3Connections")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("connection inventory exceeds the supported limit");
    const existing = args.connectionId ? rows.filter((row) => row._id === args.connectionId) : [];
    if (args.connectionId && existing.length !== 1) throw new Error("connection is unavailable");
    if (existing.length > 1) throw new Error("connection identity is ambiguous");
    if (args.connectionId && (existing[0]!.status === "disconnected" || existing[0]!.credentialVersion !== args.expectedConnectionCredentialVersion)) {
      throw new Error("connection changed while OAuth was in progress");
    }
    const values = {
      ownerSubject: args.subject, ownerIssuer: args.ownerIssuer, ownerRevision: args.revision,
      endpoint: args.endpoint, issuer: args.issuer, resource: args.resource, clientId: args.clientId,
      environmentId: args.environmentId, environmentLabel: args.environmentLabel,
      serverVersion: args.serverVersion, platform: args.platform, access: "read-only" as const,
      status: "connected" as const, tokenCiphertext: args.tokenCiphertext, expiresAt: args.expiresAt,
      credentialVersion: existing[0] ? existing[0].credentialVersion + 1 : 1,
      updatedAt: args.at, lastVerifiedAt: args.at,
    };
    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, values);
      return existing[0]._id;
    }
    return await ctx.db.insert("t3Connections", { ...values, createdAt: args.at });
  },
});

export const getConnectionSecret = internalQuery({
  args: { ...ownerArgs, connectionId: v.id("t3Connections"), now: v.number() },
  returns: v.union(v.object({
    connectionId: v.id("t3Connections"), endpoint: v.string(), issuer: v.string(),
    resource: v.string(), clientId: v.string(), tokenCiphertext: v.string(), expiresAt: v.number(),
    status: v.string(), environmentId: v.string(), credentialVersion: v.number(), updatedAt: v.number(),
  }), v.null()),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer || row.status === "disconnected") return null;
    return {
      connectionId: row._id, endpoint: row.endpoint, issuer: row.issuer, resource: row.resource,
      clientId: row.clientId, tokenCiphertext: row.tokenCiphertext, expiresAt: row.expiresAt,
      credentialVersion: row.credentialVersion,
      updatedAt: row.updatedAt,
      status: row.ownerRevision !== args.revision ? "reauthorizationRequired" : row.expiresAt <= args.now ? "expired" : row.status,
      environmentId: row.environmentId,
    };
  },
});

export const listConnections = internalQuery({
  args: { ...ownerArgs, now: v.number() },
  returns: v.array(v.object({
    connectionId: v.id("t3Connections"), endpoint: v.string(), environmentId: v.string(),
    environmentLabel: v.string(), serverVersion: v.string(), platform: v.string(),
    access: v.literal("read-only"), status: v.string(), expiresAt: v.number(),
    lastVerifiedAt: v.union(v.number(), v.null()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db.query("t3Connections")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("connection inventory exceeds the supported limit");
    return rows.filter((row) => row.status !== "disconnected").map((row) => ({
      connectionId: row._id, endpoint: row.endpoint, environmentId: row.environmentId,
      environmentLabel: row.environmentLabel, serverVersion: row.serverVersion, platform: row.platform,
      access: row.access,
      status: row.ownerRevision !== args.revision ? "reauthorizationRequired" : row.expiresAt <= args.now ? "expired" : row.status,
      expiresAt: row.expiresAt, lastVerifiedAt: row.lastVerifiedAt,
    }));
  },
});

export const recordVerification = internalMutation({
  args: {
    ...ownerArgs, connectionId: v.id("t3Connections"), credentialVersion: v.number(), at: v.number(),
    status: v.optional(v.union(v.literal("connected"), v.literal("reauthorizationRequired"), v.literal("unreachable"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer || row.status === "disconnected" || row.credentialVersion !== args.credentialVersion) return;
    await ctx.db.patch(row._id, {
      lastVerifiedAt: args.status && args.status !== "connected" ? row.lastVerifiedAt : args.at,
      updatedAt: args.at,
      ...(args.status ? { status: args.status } : {}),
    });
  },
});

export const assertConnectionCurrent = internalQuery({
  args: { ...ownerArgs, connectionId: v.id("t3Connections"), credentialVersion: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    return Boolean(row && row.ownerSubject === args.subject && row.ownerIssuer === args.ownerIssuer &&
      row.ownerRevision === args.revision && row.status === "connected" && row.credentialVersion === args.credentialVersion);
  },
});

export const disconnect = internalMutation({
  args: { ...ownerArgs, connectionId: v.id("t3Connections"), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) return false;
    await ctx.db.patch(row._id, { status: "disconnected", tokenCiphertext: "", updatedAt: args.at });
    return true;
  },
});
