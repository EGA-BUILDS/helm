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
    attemptId: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    stateHash: v.string(),
    verifierCiphertext: v.string(),
    scopes: v.array(v.string()),
    connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const previous = await ctx.db.query("linearAuthAttempts")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .order("desc")
      .take(51);
    if (previous.length > 50) throw new Error("OAuth attempt inventory exceeds the supported limit");
    const connections = await ctx.db.query("linearConnections")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (connections.length > 50) throw new Error("connection inventory exceeds the supported limit");
    const liveConnections = connections.filter((row) => row.status !== "disconnected");
    if (args.connectionId === null && liveConnections.length > 0) {
      throw new Error("A Linear connection already exists; disconnect it first");
    }
    if (args.connectionId !== null) {
      const current = liveConnections.filter((row) => row._id === args.connectionId);
      if (current.length !== 1 || current[0]!.credentialVersion !== args.expectedConnectionCredentialVersion) {
        throw new Error("Linear connection changed while OAuth was starting");
      }
      if (liveConnections.length !== 1) throw new Error("Only one Linear connection may be active");
    }
    for (const row of previous) {
      // A new attempt supersedes every older state, including a callback that
      // has already started exchanging its code. Its later save will fail because
      // the attempt row no longer exists.
      await ctx.db.delete(row._id);
    }
    const { subject, revision, ...attemptFields } = args;
    await ctx.db.insert("linearAuthAttempts", {
      ...attemptFields,
      ownerSubject: subject,
      ownerRevision: revision,
      status: "pending",
      finishedAt: null,
    });
  },
});

export const consumeAttempt = internalMutation({
  args: { ...ownerArgs, stateHash: v.string(), now: v.number() },
  returns: v.union(v.object({ expired: v.literal(true) }), v.object({
    attemptId: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    verifierCiphertext: v.string(),
    scopes: v.array(v.string()),
    connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const rows = await ctx.db.query("linearAuthAttempts")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash)).take(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status !== "pending") return null;
    if (row.expiresAt <= args.now) {
      await ctx.db.patch(row._id, { status: "expired", finishedAt: args.now });
      return { expired: true as const };
    }
    await ctx.db.patch(row._id, { status: "consuming" });
    return {
      attemptId: row.attemptId, clientId: row.clientId,
      redirectUri: row.redirectUri, verifierCiphertext: row.verifierCiphertext,
      scopes: row.scopes,
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
    const row = await ctx.db.query("linearAuthAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId)).unique();
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status !== "consuming") return;
    await ctx.db.patch(row._id, { status: args.status, finishedAt: args.at });
  },
});

export const saveConnection = internalMutation({
  args: {
    ...ownerArgs, attemptId: v.string(), connectionId: v.union(v.string(), v.null()),
    workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string(),
    accessTokenCiphertext: v.string(), refreshTokenCiphertext: v.string(),
    accessExpiresAt: v.number(), refreshExpiresAt: v.union(v.number(), v.null()),
    scopes: v.array(v.string()), clientId: v.string(), redirectUri: v.string(),
    at: v.number(), expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
  },
  returns: v.id("linearConnections"),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const attempt = await ctx.db.query("linearAuthAttempts")
      .withIndex("by_attempt_id", (q) => q.eq("attemptId", args.attemptId)).unique();
    if (!attempt || attempt.ownerSubject !== args.subject || attempt.ownerIssuer !== args.ownerIssuer ||
        attempt.ownerRevision !== args.revision || attempt.status !== "consuming" || attempt.expiresAt <= args.at) {
      throw new Error("OAuth attempt expired while completing");
    }
    if (attempt.connectionId !== args.connectionId || attempt.clientId !== args.clientId ||
        attempt.redirectUri !== args.redirectUri ||
        attempt.expectedConnectionCredentialVersion !== args.expectedConnectionCredentialVersion) {
      throw new Error("OAuth attempt does not match the connection being saved");
    }
    const rows = await ctx.db.query("linearConnections")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("connection inventory exceeds the supported limit");
    const existing = args.connectionId ? rows.filter((row) => row._id === args.connectionId) : [];
    if (args.connectionId && existing.length !== 1) throw new Error("connection is unavailable");
    if (existing.length > 1) throw new Error("connection identity is ambiguous");
    if (args.connectionId && (existing[0]!.status === "disconnected" || existing[0]!.credentialVersion !== args.expectedConnectionCredentialVersion)) {
      throw new Error("connection changed while OAuth was in progress");
    }
    const active = rows.filter((row) => row.status !== "disconnected");
    if (args.connectionId === null && active.length > 0) {
      throw new Error("A Linear connection was saved while OAuth was in progress");
    }
    if (args.connectionId !== null && active.some((row) => row._id !== args.connectionId)) {
      throw new Error("Only one Linear connection may be active");
    }
    const reusable = args.connectionId ? existing[0] : rows
      .filter((row) => row.status === "disconnected")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const values = {
      ownerSubject: args.subject, ownerIssuer: args.ownerIssuer, ownerRevision: args.revision,
      workspaceId: args.workspaceId, workspaceName: args.workspaceName, workspaceUrlKey: args.workspaceUrlKey,
      accessTokenCiphertext: args.accessTokenCiphertext, refreshTokenCiphertext: args.refreshTokenCiphertext,
      accessExpiresAt: args.accessExpiresAt, refreshExpiresAt: args.refreshExpiresAt,
      scopes: args.scopes, clientId: args.clientId, redirectUri: args.redirectUri,
      status: "connected" as const,
      credentialVersion: reusable ? reusable.credentialVersion + 1 : 1,
      updatedAt: args.at, lastVerifiedAt: args.at, lastSuccessfulReadAt: reusable?.lastSuccessfulReadAt ?? null,
      lastErrorCode: null,
    };
    if (reusable) {
      await ctx.db.patch(reusable._id, values);
      return reusable._id;
    }
    return await ctx.db.insert("linearConnections", { ...values, createdAt: args.at });
  },
});

/**
 * Rotating-refresh commit with compare-and-swap versioning.
 *
 * Linear refresh tokens ROTATE: every refresh returns a NEW refresh token that
 * must replace the stored one. Two concurrent refreshes therefore race, and the
 * loser holds a superseded refresh token that Linear has already invalidated.
 * The loser must NOT overwrite the winner's credentials: the write only lands
 * when `expectedCredentialVersion` still matches, and the loser observes
 * `false` and surfaces "changed while the refresh was in progress" instead.
 */
export const rotateCredentials = internalMutation({
  args: {
    ...ownerArgs, connectionId: v.id("linearConnections"), expectedCredentialVersion: v.number(),
    accessTokenCiphertext: v.string(), refreshTokenCiphertext: v.string(),
    accessExpiresAt: v.number(), refreshExpiresAt: v.union(v.number(), v.null()),
    scopes: v.array(v.string()), at: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status === "disconnected" ||
        row.credentialVersion !== args.expectedCredentialVersion) return false;
    await ctx.db.patch(row._id, {
      accessTokenCiphertext: args.accessTokenCiphertext, refreshTokenCiphertext: args.refreshTokenCiphertext,
      accessExpiresAt: args.accessExpiresAt, refreshExpiresAt: args.refreshExpiresAt,
      scopes: args.scopes, credentialVersion: row.credentialVersion + 1,
      status: "connected", lastVerifiedAt: args.at, updatedAt: args.at, lastErrorCode: null,
    });
    return true;
  },
});

export const getConnectionSecret = internalQuery({
  args: { ...ownerArgs, connectionId: v.id("linearConnections"), now: v.number() },
  returns: v.union(v.object({
    connectionId: v.id("linearConnections"),
    workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string(),
    accessTokenCiphertext: v.string(), refreshTokenCiphertext: v.string(),
    accessExpiresAt: v.number(), refreshExpiresAt: v.union(v.number(), v.null()),
    scopes: v.array(v.string()), clientId: v.string(), redirectUri: v.string(),
    status: v.string(), credentialVersion: v.number(), updatedAt: v.number(),
  }), v.null()),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    await requireCurrentOwnerGrant(ctx, owner);
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer || row.status === "disconnected") return null;
    return {
      connectionId: row._id,
      workspaceId: row.workspaceId, workspaceName: row.workspaceName, workspaceUrlKey: row.workspaceUrlKey,
      accessTokenCiphertext: row.accessTokenCiphertext, refreshTokenCiphertext: row.refreshTokenCiphertext,
      accessExpiresAt: row.accessExpiresAt, refreshExpiresAt: row.refreshExpiresAt,
      scopes: row.scopes, clientId: row.clientId, redirectUri: row.redirectUri,
      credentialVersion: row.credentialVersion,
      updatedAt: row.updatedAt,
      status: row.ownerRevision !== args.revision ? "reauthorizationRequired" : row.accessExpiresAt <= args.now ? "expired" : row.status,
    };
  },
});

export const listConnections = internalQuery({
  args: { ...ownerArgs, now: v.number() },
  returns: v.array(v.object({
    connectionId: v.id("linearConnections"),
    workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string(),
    scopes: v.array(v.string()), status: v.string(),
    accessExpiresAt: v.number(), refreshExpiresAt: v.union(v.number(), v.null()),
    lastVerifiedAt: v.union(v.number(), v.null()), lastSuccessfulReadAt: v.union(v.number(), v.null()),
    lastErrorCode: v.union(v.literal("authorization_required"), v.literal("authorization_expired"), v.literal("token_refresh_failed"), v.literal("workspace_identity_changed"), v.literal("rate_limited"), v.literal("read_failed"), v.literal("unreachable"), v.null()),
  })),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const rows = await ctx.db.query("linearConnections")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", args.subject).eq("ownerIssuer", args.ownerIssuer))
      .take(51);
    if (rows.length > 50) throw new Error("connection inventory exceeds the supported limit");
    return rows.filter((row) => row.status !== "disconnected").map((row) => ({
      connectionId: row._id,
      workspaceId: row.workspaceId, workspaceName: row.workspaceName, workspaceUrlKey: row.workspaceUrlKey,
      scopes: row.scopes,
      status: row.ownerRevision !== args.revision ? "reauthorizationRequired" : row.accessExpiresAt <= args.now ? "expired" : row.status,
      accessExpiresAt: row.accessExpiresAt, refreshExpiresAt: row.refreshExpiresAt,
      lastVerifiedAt: row.lastVerifiedAt,
      lastSuccessfulReadAt: row.lastSuccessfulReadAt, lastErrorCode: row.lastErrorCode,
    }));
  },
});

export const recordVerification = internalMutation({
  args: {
    ...ownerArgs, connectionId: v.id("linearConnections"), credentialVersion: v.number(), at: v.number(),
    status: v.optional(v.union(v.literal("connected"), v.literal("expired"), v.literal("reauthorizationRequired"), v.literal("unreachable"))),
    errorCode: v.optional(v.union(v.literal("authorization_required"), v.literal("authorization_expired"), v.literal("token_refresh_failed"), v.literal("workspace_identity_changed"), v.literal("rate_limited"), v.literal("read_failed"), v.literal("unreachable"))),
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
      ...(args.status === "connected" ? { lastErrorCode: null } : args.errorCode ? { lastErrorCode: args.errorCode } : args.status ? {
        lastErrorCode: args.errorCode ?? (args.status === "unreachable" ? "unreachable" : args.status === "expired" ? "authorization_expired" : "authorization_required"),
      } : {}),
    });
  },
});

export const recordSuccessfulRead = internalMutation({
  args: { ...ownerArgs, connectionId: v.id("linearConnections"), credentialVersion: v.number(), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer ||
        row.ownerRevision !== args.revision || row.status !== "connected" ||
        row.credentialVersion !== args.credentialVersion || row.accessExpiresAt <= args.at) return false;
    await ctx.db.patch(row._id, { lastSuccessfulReadAt: args.at, updatedAt: args.at, lastErrorCode: null });
    return true;
  },
});

export const assertConnectionCurrent = internalQuery({
  args: { ...ownerArgs, connectionId: v.id("linearConnections"), credentialVersion: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    return Boolean(row && row.ownerSubject === args.subject && row.ownerIssuer === args.ownerIssuer &&
      row.ownerRevision === args.revision && row.status === "connected" && row.credentialVersion === args.credentialVersion);
  },
});

export const disconnect = internalMutation({
  args: { ...ownerArgs, connectionId: v.id("linearConnections"), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireCurrentOwnerGrant(ctx, { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision });
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.ownerSubject !== args.subject || row.ownerIssuer !== args.ownerIssuer) return false;
    // Disconnect clears BOTH rotating credentials. Native T3 history and Linear
    // issues live outside this row, so neither is touched.
    await ctx.db.patch(row._id, { status: "disconnected", accessTokenCiphertext: "", refreshTokenCiphertext: "", updatedAt: args.at, lastErrorCode: null });
    return true;
  },
});
