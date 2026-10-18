/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * Linear connection lifecycle and OAuth-attempt invariants, exercised through
 * the internal store only. No network, no live Linear, no credentials: the
 * token payloads here are placeholders.
 *
 * Contract under test: an attempt is single-use and owner-bound, a reconnect
 * reuses the saved row and bumps its credential version, a concurrent refresh
 * carrying a stale version cannot overwrite newer rotating credentials, and a
 * failed or superseded reconnect leaves the existing grant untouched.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const REDIRECT = "https://helm.example/api/linear/callback";
const CLIENT_ID = "helm-linear-public-client";
const ACCESS_CIPHERTEXT = "v1.access.placeholder.placeholder";
const REFRESH_CIPHERTEXT = "v1.refresh.placeholder.placeholder";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

describe("Linear connection store", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;

  beforeEach(async () => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  function beginAttempt(
    t: Harness,
    options: {
      stateHash: string;
      connectionId?: string | null;
      expectedConnectionCredentialVersion?: number | null;
      expiresAt?: number;
      ownerOverride?: typeof owner;
    },
  ) {
    const as = options.ownerOverride ?? owner;
    return t.mutation(internal.linearConnectionsStore.createAttempt, {
      ...as,
      attemptId: `attempt-${options.stateHash}`,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      stateHash: options.stateHash,
      verifierCiphertext: "v1.pkce.placeholder.placeholder",
      scopes: ["read", "write"],
      connectionId: options.connectionId ?? null,
      expectedConnectionCredentialVersion: options.expectedConnectionCredentialVersion ?? null,
      createdAt: Date.now(),
      expiresAt: options.expiresAt ?? Date.now() + 600_000,
    });
  }

  function consume(t: Harness, stateHash: string, now = Date.now()) {
    return t.mutation(internal.linearConnectionsStore.consumeAttempt, { ...owner, stateHash, now });
  }

  function saveArgs(stateHash: string, existing?: { connectionId: string; version: number }) {
    return {
      ...owner,
      attemptId: `attempt-${stateHash}`,
      connectionId: existing?.connectionId ?? null,
      workspaceId: "workspace-1",
      workspaceName: "Helm",
      workspaceUrlKey: "helm",
      accessTokenCiphertext: ACCESS_CIPHERTEXT,
      refreshTokenCiphertext: REFRESH_CIPHERTEXT,
      accessExpiresAt: Date.now() + 24 * 60 * 60_000,
      refreshExpiresAt: null as number | null,
      scopes: ["read", "write"],
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      at: Date.now(),
      expectedConnectionCredentialVersion: existing?.version ?? null,
    };
  }

  /** Create and consume an attempt, then complete it as a saved connection. */
  async function saveConsumed(t: Harness, stateHash: string, existing?: { connectionId: string; version: number }) {
    await beginAttempt(t, {
      stateHash,
      connectionId: existing?.connectionId ?? null,
      expectedConnectionCredentialVersion: existing?.version ?? null,
    });
    await consume(t, stateHash);
    return t.mutation(internal.linearConnectionsStore.saveConnection, saveArgs(stateHash, existing));
  }

  function secret(t: Harness, connectionId: string) {
    return t.query(internal.linearConnectionsStore.getConnectionSecret, { ...owner, connectionId: connectionId as never, now: Date.now() });
  }

  it("consumes an authorization attempt exactly once", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-a" });
    const first = await consume(t, "state-a");
    expect(first).toMatchObject({ attemptId: "attempt-state-a" });
    // Replaying the same state must not mint a second exchange.
    await expect(consume(t, "state-a")).resolves.toBe(null);
  });

  it("reports an expired attempt and refuses to reuse it", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-old", expiresAt: Date.now() - 1000 });
    await expect(consume(t, "state-old")).resolves.toEqual({ expired: true });
    await expect(consume(t, "state-old")).resolves.toBe(null);
  });

  it("deletes a superseded attempt so its callback cannot complete", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-first" });
    await beginAttempt(t, { stateHash: "state-second" });
    await expect(consume(t, "state-first")).resolves.toBe(null);
    await expect(consume(t, "state-second")).resolves.toMatchObject({ attemptId: "attempt-state-second" });
  });

  it("saves one connection and refuses a competing new connection", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await expect(beginAttempt(t, { stateHash: "state-2" })).rejects.toThrow(/already exists/i);
    await expect(secret(t, connectionId)).resolves.toMatchObject({ status: "connected", workspaceId: "workspace-1" });
  });

  it("bumps the credential version on reconnect without creating a second row", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    const reconnected = await saveConsumed(t, "state-2", { connectionId, version: 1 });
    expect(reconnected).toBe(connectionId);
    await expect(secret(t, connectionId)).resolves.toMatchObject({ credentialVersion: 2 });
    await expect(t.query(internal.linearConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toHaveLength(1);
  });

  it("preserves the saved connection when a reconnect fails", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await beginAttempt(t, { stateHash: "state-2", connectionId, expectedConnectionCredentialVersion: 1 });
    await consume(t, "state-2");
    await t.mutation(internal.linearConnectionsStore.finishAttempt, { ...owner, attemptId: "attempt-state-2", status: "failed", at: Date.now() });
    // The original grant still stands, at its original version.
    await expect(secret(t, connectionId)).resolves.toMatchObject({ status: "connected", credentialVersion: 1 });
  });

  it("refuses a reconnect against a stale credential version", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await saveConsumed(t, "state-2", { connectionId, version: 1 });
    await expect(
      beginAttempt(t, { stateHash: "state-3", connectionId, expectedConnectionCredentialVersion: 1 }),
    ).rejects.toThrow(/changed while OAuth was starting/i);
  });

  it("refuses to save a second connection from a replayed attempt", async () => {
    const t = await granted();
    await saveConsumed(t, "state-1");
    await expect(
      t.mutation(internal.linearConnectionsStore.saveConnection, saveArgs("state-1")),
    ).rejects.toThrow(/saved while OAuth was in progress/i);
    await expect(t.query(internal.linearConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toHaveLength(1);
  });

  it("refuses to save when the attempt does not describe the connection being saved", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-1" });
    await consume(t, "state-1");
    // Workspace identity is discovered at callback time, not attempt time, so it
    // is intentionally not part of the attempt binding — but the client is.
    await expect(
      t.mutation(internal.linearConnectionsStore.saveConnection, {
        ...saveArgs("state-1"),
        clientId: "some-other-client",
      }),
    ).rejects.toThrow(/does not match the connection being saved/i);
  });

  it("refuses to save once the attempt has expired", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-late", expiresAt: Date.now() + 5 });
    await consume(t, "state-late");
    await expect(
      t.mutation(internal.linearConnectionsStore.saveConnection, {
        ...saveArgs("state-late"),
        at: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/expired while completing/i);
  });

  it("requires an owner grant even for the internal store", async () => {
    const t = convexTest(schema, modules);
    await expect(beginAttempt(t, { stateHash: "state-x" })).rejects.toThrow(/unauthorized/);
  });

  it("denies a stale owner revision", async () => {
    const t = await granted();
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    // Owner revision is now 2; calls presenting revision 1 must be refused.
    await expect(beginAttempt(t, { stateHash: "state-stale" })).rejects.toThrow(/unauthorized/);
  });

  it("concurrent refresh CAS: a stale version must not overwrite newer rotating credentials", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    const first = await secret(t, connectionId);
    expect(first).toMatchObject({ credentialVersion: 1 });

    // Winner: the first refresh commits the rotated pair and bumps to v2.
    const winnerCiphertext = "v1.access.winner.placeholder";
    const winnerRefresh = "v1.refresh.winner.placeholder";
    await expect(t.mutation(internal.linearConnectionsStore.rotateCredentials, {
      ...owner,
      connectionId: connectionId as never,
      expectedCredentialVersion: 1,
      accessTokenCiphertext: winnerCiphertext,
      refreshTokenCiphertext: winnerRefresh,
      accessExpiresAt: Date.now() + 24 * 60 * 60_000,
      refreshExpiresAt: null,
      scopes: ["read", "write"],
      at: Date.now(),
    })).resolves.toBe(true);

    // Loser: a concurrent refresh carrying the older v1 version is rejected and
    // leaves the winner's rotated credentials untouched.
    await expect(t.mutation(internal.linearConnectionsStore.rotateCredentials, {
      ...owner,
      connectionId: connectionId as never,
      expectedCredentialVersion: 1,
      accessTokenCiphertext: "v1.access.loser.placeholder",
      refreshTokenCiphertext: "v1.refresh.loser.placeholder",
      accessExpiresAt: Date.now() + 24 * 60 * 60_000,
      refreshExpiresAt: null,
      scopes: ["read", "write"],
      at: Date.now(),
    })).resolves.toBe(false);
    await expect(secret(t, connectionId)).resolves.toMatchObject({
      credentialVersion: 2,
      accessTokenCiphertext: winnerCiphertext,
      refreshTokenCiphertext: winnerRefresh,
    });

    // A follow-up refresh on the current version succeeds again (v2 -> v3).
    await expect(t.mutation(internal.linearConnectionsStore.rotateCredentials, {
      ...owner,
      connectionId: connectionId as never,
      expectedCredentialVersion: 2,
      accessTokenCiphertext: "v1.access.third.placeholder",
      refreshTokenCiphertext: "v1.refresh.third.placeholder",
      accessExpiresAt: Date.now() + 24 * 60 * 60_000,
      refreshExpiresAt: null,
      scopes: ["read", "write"],
      at: Date.now(),
    })).resolves.toBe(true);
    await expect(secret(t, connectionId)).resolves.toMatchObject({ credentialVersion: 3 });
  });

  it("disconnect clears both ciphertexts and leaves no active connection", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await expect(t.mutation(internal.linearConnectionsStore.disconnect, { ...owner, connectionId: connectionId as never, at: Date.now() })).resolves.toBe(true);
    await expect(secret(t, connectionId)).resolves.toBe(null);
    await expect(t.query(internal.linearConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toEqual([]);
    const rows = await t.run(async (ctx) => await ctx.db.query("linearConnections").collect());
    expect(rows[0]?.accessTokenCiphertext).toBe("");
    expect(rows[0]?.refreshTokenCiphertext).toBe("");
    expect(rows[0]?.status).toBe("disconnected");
  });
});
