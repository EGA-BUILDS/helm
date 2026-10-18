"use node";

import { randomBytes } from "node:crypto";
import { v, type Infer } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  LINEAR_REQUESTED_SCOPES,
  LINEAR_TOKEN_ENDPOINT,
  LINEAR_WORKSPACE_IDENTITY_QUERY,
  LINEAR_GRAPHQL_ENDPOINT,
  buildLinearAuthorizeUrl,
  decryptLinearSecret,
  encryptLinearSecret,
  linearB64url,
  linearCallbackUri,
  linearClientId,
  linearClientSecret,
  linearFetch,
  linearJson,
  linearPkceChallenge,
  linearPkcePurpose,
  linearAccessPurpose,
  linearRefreshPurpose,
  linearStateDigest,
  parseLinearGrantedScopes,
  parseLinearWorkspaceIdentity,
  requiredTokenLifetime,
  requiredTokenString,
  validateLinearCallbackParams,
} from "./lib/linearHelpers";

type Owner = { subject: string; issuer: string; revision: number };
type Json = Record<string, unknown>;
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
};

function tokenForm(params: Record<string, string>): { url: string; init: RequestInit } {
  const secret = linearClientSecret();
  const body = new URLSearchParams({
    ...params,
    client_id: linearClientId(),
    ...(secret ? { client_secret: secret } : {}),
  });
  return {
    url: LINEAR_TOKEN_ENDPOINT,
    init: {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  };
}

function parseTokenSet(value: Json): TokenSet {
  const accessToken = requiredTokenString(value.access_token, "access token");
  if (value.token_type !== "Bearer") throw new Error("Linear returned an invalid token type");
  const expiresIn = requiredTokenLifetime(value.expires_in);
  const refreshToken = requiredTokenString(value.refresh_token, "refresh token");
  const scopes = parseLinearGrantedScopes(value.scope);
  return { accessToken, refreshToken, expiresIn, scopes };
}

async function readWorkspaceIdentity(accessToken: string, assertOwnerCurrent: () => Promise<unknown>) {
  await assertOwnerCurrent();
  const response = await linearJson(await linearFetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: LINEAR_WORKSPACE_IDENTITY_QUERY, variables: {} }),
  }));
  return parseLinearWorkspaceIdentity(response);
}

export const start = action({
  args: { redirectUri: v.optional(v.string()), connectionId: v.optional(v.id("linearConnections")) },
  returns: v.object({ attemptId: v.string(), authorizationUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(internal.linearConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const clientId = linearClientId();
    let expectedConnectionCredentialVersion: number | null = null;
    if (args.connectionId) {
      const existing = await ctx.runQuery(internal.linearConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner), connectionId: args.connectionId, now: Date.now(),
      });
      if (!existing) throw new Error("Reconnect must target an existing Linear connection");
      expectedConnectionCredentialVersion = existing.credentialVersion;
    } else {
      const existing = await ctx.runQuery(internal.linearConnectionsStore.listConnections, {
        ...storeOwner(owner), now: Date.now(),
      });
      if (existing.length > 0) throw new Error("A Linear connection already exists; disconnect it first");
    }
    await assertOwnerCurrent();
    const redirectUri = linearCallbackUri();
    if (args.redirectUri && args.redirectUri !== redirectUri) throw new Error("OAuth callback URI mismatch");
    const state = linearB64url(randomBytes(32));
    const verifier = linearB64url(randomBytes(32));
    const challenge = linearPkceChallenge(verifier);
    const attemptId = linearB64url(randomBytes(18));
    const createdAt = Date.now();
    const expiresAt = createdAt + 10 * 60_000;
    await ctx.runMutation(internal.linearConnectionsStore.createAttempt, {
      ...storeOwner(owner), attemptId, clientId, redirectUri, stateHash: linearStateDigest(state),
      verifierCiphertext: encryptLinearSecret(verifier, linearPkcePurpose(owner.issuer, owner.subject, attemptId)),
      scopes: [...LINEAR_REQUESTED_SCOPES],
      connectionId: args.connectionId ?? null, expectedConnectionCredentialVersion, createdAt, expiresAt,
    });
    return {
      attemptId,
      authorizationUrl: buildLinearAuthorizeUrl({
        clientId, redirectUri, state, challenge, scopes: LINEAR_REQUESTED_SCOPES,
      }),
      expiresAt,
    };
  },
});

export const callback = action({
  args: { state: v.string(), code: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.object({ connectionId: v.union(v.id("linearConnections"), v.null()), status: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectionId: Id<"linearConnections"> | null;
    status: string;
  }> => {
    validateLinearCallbackParams(args);
    const owner = await ctx.runQuery(internal.linearConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const now = Date.now();
    const pending = await ctx.runMutation(internal.linearConnectionsStore.consumeAttempt, {
      ...storeOwner(owner), stateHash: linearStateDigest(args.state), now,
    });
    if (!pending) throw new Error("OAuth attempt is invalid or expired");
    if ("expired" in pending) return { connectionId: null, status: "expired" };
    try {
      if (args.error) {
        const status = args.error === "access_denied" ? "denied" : args.error === "consent_expired" ? "expired" : "failed";
        await ctx.runMutation(internal.linearConnectionsStore.finishAttempt, {
          ...storeOwner(owner), attemptId: pending.attemptId, status, at: Date.now(),
        });
        return { connectionId: null, status };
      }
      if (!args.code) throw new Error("Linear OAuth callback is invalid");
      const verifier = decryptLinearSecret(
        pending.verifierCiphertext, linearPkcePurpose(owner.issuer, owner.subject, pending.attemptId));
      const { url, init } = tokenForm({
        grant_type: "authorization_code", code: args.code,
        redirect_uri: pending.redirectUri, code_verifier: verifier,
      });
      const tokens = parseTokenSet(await linearJson(await linearFetch(url, init)));
      const tokenReceivedAt = Date.now();
      const identity = await readWorkspaceIdentity(tokens.accessToken, assertOwnerCurrent);
      const savedAt = Date.now();
      const connectionId = await ctx.runMutation(internal.linearConnectionsStore.saveConnection, {
        ...storeOwner(owner), attemptId: pending.attemptId, connectionId: pending.connectionId,
        workspaceId: identity.workspaceId, workspaceName: identity.workspaceName, workspaceUrlKey: identity.workspaceUrlKey,
        accessTokenCiphertext: encryptLinearSecret(
          tokens.accessToken, linearAccessPurpose(owner.issuer, owner.subject, identity.workspaceId)),
        refreshTokenCiphertext: encryptLinearSecret(
          tokens.refreshToken, linearRefreshPurpose(owner.issuer, owner.subject, identity.workspaceId)),
        accessExpiresAt: tokenReceivedAt + tokens.expiresIn * 1000, refreshExpiresAt: null,
        scopes: tokens.scopes, clientId: pending.clientId, redirectUri: pending.redirectUri,
        at: savedAt, expectedConnectionCredentialVersion: pending.expectedConnectionCredentialVersion,
      });
      await ctx.runMutation(internal.linearConnectionsStore.finishAttempt, {
        ...storeOwner(owner), attemptId: pending.attemptId, status: "connected", at: Date.now(),
      });
      return { connectionId, status: "connected" };
    } catch {
      await ctx.runMutation(internal.linearConnectionsStore.finishAttempt, {
        ...storeOwner(owner), attemptId: pending.attemptId, status: "failed", at: Date.now(),
      });
      throw new Error("Linear connection could not be completed; existing connection remains unchanged");
    }
  },
});

const connectionListReturns = v.array(
  v.object({
    connectionId: v.id("linearConnections"),
    workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string(),
    scopes: v.array(v.string()), status: v.string(),
    accessExpiresAt: v.number(), refreshExpiresAt: v.union(v.number(), v.null()),
    lastVerifiedAt: v.union(v.number(), v.null()),
    lastSuccessfulReadAt: v.union(v.number(), v.null()),
    lastErrorCode: v.union(v.literal("authorization_required"), v.literal("authorization_expired"), v.literal("token_refresh_failed"), v.literal("workspace_identity_changed"), v.literal("rate_limited"), v.literal("read_failed"), v.literal("unreachable"), v.null()),
  }),
);

export const list = action({
  args: {},
  returns: connectionListReturns,
  handler: async (
    ctx,
  ): Promise<Infer<typeof connectionListReturns>> => {
    const owner = await ctx.runQuery(internal.linearConnectionsStore.ownerContext, {});
    return await ctx.runQuery(internal.linearConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
  },
});

export const disconnect = action({
  args: { connectionId: v.id("linearConnections") }, returns: v.boolean(),
  handler: async (
    ctx,
    args,
  ): Promise<boolean> => {
    const owner = await ctx.runQuery(internal.linearConnectionsStore.ownerContext, {});
    return await ctx.runMutation(internal.linearConnectionsStore.disconnect, { ...storeOwner(owner), connectionId: args.connectionId, at: Date.now() });
  },
});

const refreshReturns = v.object({
  workspace: v.object({ workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string() }),
  scopes: v.array(v.string()),
  accessExpiresAt: v.number(),
  observedAt: v.string(),
});

export const refresh = action({
  args: { connectionId: v.id("linearConnections") },
  returns: refreshReturns,
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof refreshReturns>> => {
    const owner = await ctx.runQuery(internal.linearConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const now = Date.now();
    const row = await ctx.runQuery(internal.linearConnectionsStore.getConnectionSecret, {
      ...storeOwner(owner), connectionId: args.connectionId, now,
    });
    if (!row) throw new Error("Linear connection is unavailable");
    if (row.status === "expired" || row.status === "reauthorizationRequired") {
      const expired = row.status === "expired";
      await ctx.runMutation(internal.linearConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion, at: now,
        status: expired ? "expired" : "reauthorizationRequired",
        errorCode: expired ? "authorization_expired" : "authorization_required",
      });
      throw new Error(expired ? "Linear connection has expired; reconnect it to continue" : "Linear authorization was revoked; reconnect to continue");
    }
    // Distinct AAD purposes keep the two rotating credentials domain-separated.
    const refreshToken = decryptLinearSecret(
      row.refreshTokenCiphertext, linearRefreshPurpose(owner.issuer, owner.subject, row.workspaceId));
    const assertBeforeRequest = async () => {
      await assertOwnerCurrent();
      const current = await ctx.runQuery(internal.linearConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner), connectionId: row.connectionId, now: Date.now(),
      });
      if (!current || current.credentialVersion !== row.credentialVersion ||
          current.status === "expired" || current.status === "reauthorizationRequired") {
        throw new Error("Linear connection changed while the refresh was in progress");
      }
    };
    try {
      await assertBeforeRequest();
      const { url, init } = tokenForm({ grant_type: "refresh_token", refresh_token: refreshToken });
      const tokens = parseTokenSet(await linearJson(await linearFetch(url, init)));
      const tokenReceivedAt = Date.now();
      const identity = await readWorkspaceIdentity(tokens.accessToken, assertOwnerCurrent);
      if (identity.workspaceId !== row.workspaceId) throw new Error("Linear workspace identity changed");
      const at = Date.now();
      const rotated = await ctx.runMutation(internal.linearConnectionsStore.rotateCredentials, {
        ...storeOwner(owner), connectionId: args.connectionId, expectedCredentialVersion: row.credentialVersion,
        accessTokenCiphertext: encryptLinearSecret(
          tokens.accessToken, linearAccessPurpose(owner.issuer, owner.subject, row.workspaceId)),
        refreshTokenCiphertext: encryptLinearSecret(
          tokens.refreshToken, linearRefreshPurpose(owner.issuer, owner.subject, row.workspaceId)),
        accessExpiresAt: tokenReceivedAt + tokens.expiresIn * 1000, refreshExpiresAt: null,
        scopes: tokens.scopes, at,
      });
      if (!rotated) throw new Error("Linear connection changed while the refresh was in progress");
      return {
        workspace: { workspaceId: row.workspaceId, workspaceName: row.workspaceName, workspaceUrlKey: row.workspaceUrlKey },
        scopes: tokens.scopes,
        accessExpiresAt: tokenReceivedAt + tokens.expiresIn * 1000,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Linear connection changed while the refresh was in progress") throw error;
      const unauthorized = /Linear request failed \((401|403)\)/.test(message);
      const identityChanged = /workspace identity changed/.test(message);
      const rateLimited = /Linear request failed \(429\)/.test(message);
      const unreachable = /could not be reached|timed out|Linear request failed \(5\d\d\)/i.test(message);
      const status = unauthorized || identityChanged ? "reauthorizationRequired" as const : unreachable ? "unreachable" as const : undefined;
      const errorCode = unauthorized ? "authorization_required" as const : identityChanged ? "workspace_identity_changed" as const :
        rateLimited ? "rate_limited" as const : unreachable ? "unreachable" as const : "token_refresh_failed" as const;
      await ctx.runMutation(internal.linearConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion, at: Date.now(),
        ...(status ? { status } : {}),
        errorCode,
      });
      if (rateLimited) throw new Error("Linear request failed (429)");
      if (status === "reauthorizationRequired") throw new Error(unauthorized ? "Linear authorization was revoked; reconnect to continue" : "Linear workspace identity changed; reconnect to confirm the workspace");
      if (status === "unreachable") throw new Error("Linear workspace could not be reached");
      throw new Error("Linear token refresh failed");
    }
  },
});
