/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * Connection lifecycle and OAuth-attempt invariants, exercised through the
 * internal store only. No network, no live T3, no credentials: the token
 * payloads here are placeholders.
 *
 * Contract under test: an attempt is single-use and owner-bound, a reconnect
 * reuses the saved row and bumps its credential version, and a failed or
 * superseded reconnect leaves the existing grant untouched.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ENDPOINT = `https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp`;
const REDIRECT = "https://helm.example/api/t3/callback";
const CLIENT_ID = "helm-public-client";
const TOKEN = "v1.placeholder.placeholder.placeholder";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

describe("T3 connection store", () => {
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
    },
  ) {
    return t.mutation(internal.t3ConnectionsStore.createAttempt, {
      ...owner,
      attemptId: `attempt-${options.stateHash}`,
      endpoint: ENDPOINT,
      issuer: OWNER_ISSUER,
      resource: ENDPOINT,
      authorizationEndpoint: `${OWNER_ISSUER}/oauth/mcp/authorize`,
      tokenEndpoint: `${OWNER_ISSUER}/oauth/mcp/token`,
      registrationEndpoint: `${OWNER_ISSUER}/oauth/mcp/register`,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      stateHash: options.stateHash,
      verifierCiphertext: "v1.placeholder.placeholder.placeholder",
      connectionId: options.connectionId ?? null,
      expectedConnectionCredentialVersion: options.expectedConnectionCredentialVersion ?? null,
      createdAt: Date.now(),
      expiresAt: options.expiresAt ?? Date.now() + 600_000,
    });
  }

  function consume(t: Harness, stateHash: string, now = Date.now()) {
    return t.mutation(internal.t3ConnectionsStore.consumeAttempt, { ...owner, stateHash, now });
  }

  /** Create and consume an attempt, then complete it as a saved connection. */
  async function saveConsumed(t: Harness, stateHash: string, existing?: { connectionId: string; version: number }) {
    await beginAttempt(t, {
      stateHash,
      connectionId: existing?.connectionId ?? null,
      expectedConnectionCredentialVersion: existing?.version ?? null,
    });
    await consume(t, stateHash);
    return t.mutation(internal.t3ConnectionsStore.saveConnection, {
      ...owner,
      attemptId: `attempt-${stateHash}`,
      connectionId: existing?.connectionId ?? null,
      endpoint: ENDPOINT,
      issuer: OWNER_ISSUER,
      resource: ENDPOINT,
      clientId: CLIENT_ID,
      environmentId: "env-openclaw",
      environmentLabel: "openclaw",
      serverVersion: "0.0.46",
      platform: "linux/arm64",
      tokenCiphertext: TOKEN,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      at: Date.now(),
      expectedConnectionCredentialVersion: existing?.version ?? null,
    });
  }

  function secret(t: Harness, connectionId: string) {
    return t.query(internal.t3ConnectionsStore.getConnectionSecret, { ...owner, connectionId: connectionId as never, now: Date.now() });
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
    await expect(secret(t, connectionId)).resolves.toMatchObject({ status: "connected", environmentId: "env-openclaw" });
  });

  it("bumps the credential version on reconnect without creating a second row", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    const reconnected = await saveConsumed(t, "state-2", { connectionId, version: 1 });
    expect(reconnected).toBe(connectionId);
    await expect(secret(t, connectionId)).resolves.toMatchObject({ credentialVersion: 2 });
    await expect(t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toHaveLength(1);
  });

  it("preserves the saved connection when a reconnect fails", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await beginAttempt(t, { stateHash: "state-2", connectionId, expectedConnectionCredentialVersion: 1 });
    await consume(t, "state-2");
    await t.mutation(internal.t3ConnectionsStore.finishAttempt, { ...owner, attemptId: "attempt-state-2", status: "failed", at: Date.now() });
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
      t.mutation(internal.t3ConnectionsStore.saveConnection, {
        ...owner,
        attemptId: "attempt-state-1",
        connectionId: null,
        endpoint: ENDPOINT,
        issuer: OWNER_ISSUER,
        resource: ENDPOINT,
        clientId: CLIENT_ID,
        environmentId: "env-x",
        environmentLabel: "x",
        serverVersion: "0.0.46",
        platform: "linux/arm64",
        tokenCiphertext: TOKEN,
        expiresAt: Date.now() + 1000,
        at: Date.now(),
        expectedConnectionCredentialVersion: null,
      }),
    ).rejects.toThrow(/saved while OAuth was in progress/i);
    await expect(t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toHaveLength(1);
  });

  it("refuses to save when the attempt does not describe the connection being saved", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-1" });
    await consume(t, "state-1");
    await expect(
      t.mutation(internal.t3ConnectionsStore.saveConnection, {
        ...owner,
        attemptId: "attempt-state-1",
        connectionId: null,
        endpoint: `https://studio.t3coderelay.com/mcp`,
        issuer: OWNER_ISSUER,
        resource: ENDPOINT,
        clientId: CLIENT_ID,
        environmentId: "env-x",
        environmentLabel: "x",
        serverVersion: "0.0.46",
        platform: "linux/arm64",
        tokenCiphertext: TOKEN,
        expiresAt: Date.now() + 1000,
        at: Date.now(),
        expectedConnectionCredentialVersion: null,
      }),
    ).rejects.toThrow(/does not match the connection being saved/i);
  });

  it("refuses to save once the attempt has expired", async () => {
    const t = await granted();
    await beginAttempt(t, { stateHash: "state-late", expiresAt: Date.now() + 5 });
    await consume(t, "state-late");
    await expect(
      t.mutation(internal.t3ConnectionsStore.saveConnection, {
        ...owner,
        attemptId: "attempt-state-late",
        connectionId: null,
        endpoint: ENDPOINT,
        issuer: OWNER_ISSUER,
        resource: ENDPOINT,
        clientId: CLIENT_ID,
        environmentId: "env-x",
        environmentLabel: "x",
        serverVersion: "0.0.46",
        platform: "linux/arm64",
        tokenCiphertext: TOKEN,
        expiresAt: Date.now() + 1000,
        at: Date.now() + 60_000,
        expectedConnectionCredentialVersion: null,
      }),
    ).rejects.toThrow(/expired while completing/i);
  });

  it("requires an owner grant even for the internal store", async () => {
    const t = convexTest(schema, modules);
    await expect(beginAttempt(t, { stateHash: "state-x" })).rejects.toThrow(/unauthorized/);
  });

  it("disconnect clears the ciphertext and removes the connection from the inventory", async () => {
    const t = await granted();
    const connectionId = await saveConsumed(t, "state-1");
    await expect(t.mutation(internal.t3ConnectionsStore.disconnect, { ...owner, connectionId: connectionId as never, at: Date.now() })).resolves.toBe(true);
    await expect(secret(t, connectionId)).resolves.toBe(null);
    await expect(t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() })).resolves.toEqual([]);
    const rows = await t.run(async (ctx) => await ctx.db.query("t3Connections").collect());
    expect(rows[0]?.tokenCiphertext).toBe("");
  });
});

describe("T3 connection store: one active connection per access level", () => {
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

  function attemptArgs(stateHash: string, access: "read-only" | "operate", connectionId: string | null = null) {
    return {
      ...owner,
      attemptId: `attempt-${access}-${stateHash}`,
      endpoint: ENDPOINT,
      issuer: OWNER_ISSUER,
      resource: ENDPOINT,
      authorizationEndpoint: `${OWNER_ISSUER}/oauth/mcp/authorize`,
      tokenEndpoint: `${OWNER_ISSUER}/oauth/mcp/token`,
      registrationEndpoint: `${OWNER_ISSUER}/oauth/mcp/register`,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      stateHash,
      verifierCiphertext: "v1.placeholder.placeholder.placeholder",
      connectionId,
      expectedConnectionCredentialVersion: null,
      access,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    };
  }

  async function saveConsumed(t: Harness, stateHash: string, access: "read-only" | "operate") {
    await t.mutation(internal.t3ConnectionsStore.createAttempt, attemptArgs(stateHash, access));
    await t.mutation(internal.t3ConnectionsStore.consumeAttempt, { ...owner, stateHash, now: Date.now() });
    return t.mutation(internal.t3ConnectionsStore.saveConnection, {
      ...owner,
      attemptId: `attempt-${access}-${stateHash}`,
      connectionId: null,
      endpoint: ENDPOINT,
      issuer: OWNER_ISSUER,
      resource: ENDPOINT,
      clientId: CLIENT_ID,
      access,
      environmentId: "env-openclaw",
      environmentLabel: "openclaw",
      serverVersion: "0.0.46",
      platform: "linux/arm64",
      tokenCiphertext: TOKEN,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      at: Date.now(),
      expectedConnectionCredentialVersion: null,
    });
  }

  it("a read-only and an operate connection coexist, each with its own level", async () => {
    const t = await granted();
    const readonlyId = await saveConsumed(t, "ro-1", "read-only");
    const operateId = await saveConsumed(t, "op-1", "operate");
    expect(operateId).not.toBe(readonlyId);
    const rows = await t.query(internal.t3ConnectionsStore.listConnections, { ...owner, now: Date.now() });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => String(row.connectionId) === String(readonlyId))?.access).toBe("read-only");
    expect(rows.find((row) => String(row.connectionId) === String(operateId))?.access).toBe("operate");
  });

  it("refuses a second connection of the same access level", async () => {
    const t = await granted();
    await saveConsumed(t, "ro-1", "read-only");
    await expect(
      t.mutation(internal.t3ConnectionsStore.createAttempt, attemptArgs("ro-2", "read-only")),
    ).rejects.toThrow(/already exists/i);
    await saveConsumed(t, "op-1", "operate");
    await expect(
      t.mutation(internal.t3ConnectionsStore.createAttempt, attemptArgs("op-2", "operate")),
    ).rejects.toThrow(/operate.*already exists/i);
  });

  it("a reconnect keeps working per level while the other level is active", async () => {
    const t = await granted();
    const readonlyId = await saveConsumed(t, "ro-1", "read-only");
    await saveConsumed(t, "op-1", "operate");
    // Reconnect the read-only row: same access, correct version.
    const stateHash = "ro-reconnect";
    await t.mutation(internal.t3ConnectionsStore.createAttempt, {
      ...attemptArgs(stateHash, "read-only", String(readonlyId)),
      expectedConnectionCredentialVersion: 1,
    });
    await t.mutation(internal.t3ConnectionsStore.consumeAttempt, { ...owner, stateHash, now: Date.now() });
    const reconnected = await t.mutation(internal.t3ConnectionsStore.saveConnection, {
      ...owner,
      attemptId: `attempt-read-only-${stateHash}`,
      connectionId: String(readonlyId),
      endpoint: ENDPOINT,
      issuer: OWNER_ISSUER,
      resource: ENDPOINT,
      clientId: CLIENT_ID,
      environmentId: "env-openclaw",
      environmentLabel: "openclaw",
      serverVersion: "0.0.46",
      platform: "linux/arm64",
      tokenCiphertext: TOKEN,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      at: Date.now(),
      expectedConnectionCredentialVersion: 1,
    });
    expect(String(reconnected)).toBe(String(readonlyId));
  });

  it("never upgrades a read-only row to operate, at start or at save", async () => {
    const t = await granted();
    // Saving with an access that differs from the attempt's is refused, so a
    // legacy read-only attempt can never mint an operate row.
    await t.mutation(internal.t3ConnectionsStore.createAttempt, attemptArgs("legacy", "read-only"));
    await t.mutation(internal.t3ConnectionsStore.consumeAttempt, { ...owner, stateHash: "legacy", now: Date.now() });
    await expect(
      t.mutation(internal.t3ConnectionsStore.saveConnection, {
        ...owner,
        attemptId: "attempt-read-only-legacy",
        connectionId: null,
        endpoint: ENDPOINT,
        issuer: OWNER_ISSUER,
        resource: ENDPOINT,
        clientId: CLIENT_ID,
        access: "operate" as const,
        environmentId: "env-x",
        environmentLabel: "x",
        serverVersion: "0.0.46",
        platform: "linux/arm64",
        tokenCiphertext: TOKEN,
        expiresAt: Date.now() + 1000,
        at: Date.now(),
        expectedConnectionCredentialVersion: null,
      }),
    ).rejects.toThrow(/does not match the connection being saved/i);
    const readonlyId = await saveConsumed(t, "ro-1", "read-only");
    // Starting an operate consent against the read-only row is refused.
    await expect(
      t.mutation(internal.t3ConnectionsStore.createAttempt, {
        ...attemptArgs("x-access", "operate", String(readonlyId)),
        expectedConnectionCredentialVersion: 1,
      }),
    ).rejects.toThrow(/access changed/);
    await expect(
      t.query(internal.t3ConnectionsStore.getConnectionSecret, {
        ...owner, connectionId: readonlyId as never, now: Date.now(),
      }),
    ).resolves.toMatchObject({ access: "read-only" });
  });
});
