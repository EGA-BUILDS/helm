import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { classifyUnclaimedAttempt } from "./lib/directLaunchOutcome";
import {
  DIRECT_NAMESPACE_CHANGED,
  DIRECT_PAYLOAD_MISMATCH,
  DIRECT_TARGET_MISMATCH,
} from "./lib/directLaunchErrors";

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

/**
 * EGA-812 — direct-launch ledger invariants at the mutation boundary.
 *
 * These tests drive the actual Convex mutations (not pure helpers): atomic
 * intent reservation, the single irreversible dispatch claim, monotonic
 * acknowledgement/reconciliation, owner isolation, and independence from the
 * legacy issue-bound `launchAttempts` table.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ENV_ID = "env-op";
const PROJECT = "t3-proj-1";
const PAYLOAD_A = "a".repeat(64);
const PAYLOAD_B = "b".repeat(64);
const at = 1_700_000_000_000;

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

async function insertConnection(t: Harness, overrides: Record<string, unknown> = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      endpoint: "https://operate.example.invalid/mcp",
      issuer: "https://operate.example.invalid/mcp",
      resource: "https://operate.example.invalid/mcp",
      clientId: "helm-test-client",
      environmentId: ENV_ID,
      environmentLabel: "Op",
      serverVersion: "v",
      platform: "linux/x64",
      access: "operate",
      status: "connected",
      tokenCiphertext: "v1.iv.tag.ciphertext",
      credentialVersion: 1,
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastVerifiedAt: null,
      lastSuccessfulReadAt: null,
      lastErrorCode: null,
      ...overrides,
    }),
  );
}

function reserveArgs(connectionId: Id<"t3Connections">, overrides: Record<string, unknown> = {}) {
  return {
    ownerSubject: OWNER_SUBJECT,
    ownerIssuer: OWNER_ISSUER,
    ownerRevision: 1,
    connectionId,
    credentialVersion: 1,
    environmentId: ENV_ID,
    projectId: PROJECT,
    attemptId: "intent-1",
    payloadHash: PAYLOAD_A,
    ...overrides,
  };
}

function claimArgs(_connectionId: Id<"t3Connections">, overrides: Record<string, unknown> = {}) {
  return {
    ownerSubject: OWNER_SUBJECT,
    ownerIssuer: OWNER_ISSUER,
    attemptId: "intent-1",
    credentialVersion: 1,
    ownerRevision: 1,
    at,
    ...overrides,
  };
}

async function rows(t: Harness) {
  return await t.run(async (ctx) => await ctx.db.query("directLaunchAttempts").collect());
}

describe("directLaunchAttempts: atomic intent reservation", () => {
  it("persists the full identity and a unique native key before dispatch", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    const reserved = await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));

    expect(reserved.state).toBe("prepared");
    expect(reserved.reused).toBe(false);
    expect(reserved.attemptId).toBe("intent-1");
    expect(reserved.correlationKey).toMatch(/^\[helm:direct:[a-z0-9]+\]$/);
    expect(reserved.clientRequestId).toMatch(/^helm-direct-[a-z0-9]+$/);
    expect(reserved.connectionId).toBe(connectionId);
    expect(reserved.environmentId).toBe(ENV_ID);
    expect(reserved.projectId).toBe(PROJECT);
    expect(reserved.namespaceChanged).toBe(false);

    const stored = await t.query(internal.directLaunchAttempts.getDirectAttempt, {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
    });
    expect(stored).toMatchObject({
      attemptId: "intent-1",
      state: "prepared",
      threadId: null,
      projectId: PROJECT,
      environmentId: ENV_ID,
      credentialVersion: 1,
      ownerRevision: 1,
      payloadHash: PAYLOAD_A,
      dispatchedAt: null,
      acknowledgedAt: null,
      matchCount: null,
    });
  });

  it("is idempotent on (intent, payload): one row, same native keys", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    const first = await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    const retry = await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));

    expect(retry.reused).toBe(true);
    expect(retry.correlationKey).toBe(first.correlationKey);
    expect(retry.clientRequestId).toBe(first.clientRequestId);
    expect(retry.namespaceChanged).toBe(false);
    expect(await rows(t)).toHaveLength(1);
  });

  it("reports a changed credential namespace instead of reinterpreting the intent", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    const retry = await t.mutation(
      internal.directLaunchAttempts.reserveDirectLaunch,
      reserveArgs(connectionId, { credentialVersion: 2 }),
    );
    expect(retry.reused).toBe(true);
    expect(retry.namespaceChanged).toBe(true);
    expect(await rows(t)).toHaveLength(1);
  });

  it("refuses the same intent with a different payload", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await expect(
      t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId, { payloadHash: PAYLOAD_B })),
    ).rejects.toThrow(DIRECT_PAYLOAD_MISMATCH);
    expect(await rows(t)).toHaveLength(1);
  });

  it("refuses the same intent for a different target", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await expect(
      t.mutation(
        internal.directLaunchAttempts.reserveDirectLaunch,
        reserveArgs(connectionId, { projectId: "t3-proj-2" }),
      ),
    ).rejects.toThrow(DIRECT_TARGET_MISMATCH);
    expect(await rows(t)).toHaveLength(1);
  });

  it("validates the hash and the intent id", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await expect(
      t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId, { payloadHash: "nope" })),
    ).rejects.toThrow(/SHA-256/);
    await expect(
      t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId, { attemptId: "bad id" })),
    ).rejects.toThrow(/intent id/);
    expect(await rows(t)).toHaveLength(0);
  });

  it("isolates owners: the same intent id belongs to its own owner", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(
      internal.directLaunchAttempts.reserveDirectLaunch,
      reserveArgs(connectionId, { ownerSubject: "another-owner", ownerIssuer: OWNER_ISSUER }),
    );
    expect(await rows(t)).toHaveLength(2);

    const foreign = await t.query(internal.directLaunchAttempts.getDirectAttempt, {
      ownerSubject: "another-owner",
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
    });
    const mine = await t.query(internal.directLaunchAttempts.getDirectAttempt, {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
    });
    expect(foreign?.attemptId).toBe("intent-1");
    expect(mine?.attemptId).toBe("intent-1");
    expect(foreign?.correlationKey).not.toBe(mine?.correlationKey);
  });

  it("keeps two distinct intents in one project independent (no project mutex)", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId, { attemptId: "intent-a" }));
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId, { attemptId: "intent-b" }));
    // Make the first ambiguous; the second must remain fully usable.
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId, { attemptId: "intent-a" }));
    await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-a",
      matchCount: 0,
      threadId: null,
    });
    expect((await rows(t)).find((row) => row.attemptId === "intent-a")?.state).toBe("ambiguous");
    const claimed = await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId, { attemptId: "intent-b" }));
    expect(claimed).toBe(true);
  });
});

describe("directLaunchAttempts: single irreversible dispatch claim", () => {
  it("lets exactly one concurrent claimant win", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    const claims = await Promise.all([
      t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId)),
      t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await rows(t))[0]!.state).toBe("dispatching");
    expect((await rows(t))[0]!.dispatchedAt).toBe(at);
  });

  it("refuses to claim on a changed credential namespace", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await expect(
      t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId, { credentialVersion: 2 })),
    ).rejects.toThrow(DIRECT_NAMESPACE_CHANGED);
    expect((await rows(t))[0]!.state).toBe("prepared");
  });

  it("cannot re-claim a settled attempt", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
      threadId: testThreadId(1),
      at,
    });
    const again = await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));
    expect(again).toBe(false);
  });
});

describe("directLaunchAttempts: monotonic acknowledgement and reconciliation", () => {
  it("does not acknowledge an intent that was never claimed", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await expect(
      t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, {
        ownerSubject: OWNER_SUBJECT,
        ownerIssuer: OWNER_ISSUER,
        attemptId: "intent-1",
        threadId: testThreadId(1),
        at,
      }),
    ).rejects.toThrow(/cannot be acknowledged/);
    expect((await rows(t))[0]!.state).toBe("prepared");
  });

  it("is idempotent on the same thread and refuses a different one", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));
    const ack = {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
      threadId: testThreadId(1),
      at,
    };
    await t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, ack);
    await t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, ack);
    await expect(
      t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, { ...ack, threadId: testThreadId(2) }),
    ).rejects.toThrow(/refusing to re-acknowledge/);
    expect((await rows(t))[0]!.threadId).toBe(testThreadId(1));
  });

  it("zero matches are ambiguous, one match reconciles, and a late observation never regresses", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));

    const zero = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 0, threadId: null,
    });
    expect(zero.state).toBe("ambiguous");
    expect(zero.relaunchAuthorized).toBe(false);
    expect(zero.safeToProceed).toBe(false);

    const one = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 1, threadId: testThreadId(5),
    });
    expect(one.state).toBe("reconciled");
    expect(one.safeToProceed).toBe(true);
    expect(one.threadId).toBe(testThreadId(5));

    const late = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 0, threadId: null,
    });
    expect(late.state).toBe("reconciled");
    expect(late.threadId).toBe(testThreadId(5));
    expect(late.note).toMatch(/acknowledged result is preserved/);
  });

  it("never invents an ambiguous state for a prepared (provably unsent) intent", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    const rec = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 0, threadId: null,
    });
    expect(rec.state).toBe("prepared");
    expect(rec.safeToProceed).toBe(false);
    expect((await rows(t))[0]!.state).toBe("prepared");
  });

  it("remote evidence wins over abandonment; zero/many never discards it", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.abandonDirectAttempt, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1",
    });

    // A zero observation must not silently convert the operator's explicit
    // abandonment into "maybe sent".
    const zero = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 0, threadId: null,
    });
    expect(zero.state).toBe("abandoned");
    expect(zero.safeToProceed).toBe(false);

    // A real thread is proof even though the operator abandoned the wait.
    const ack = await t.mutation(internal.directLaunchAttempts.markDirectAcknowledged, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", threadId: testThreadId(7), at,
    });
    expect(ack).toBe(null);
    expect((await rows(t))[0]!.state).toBe("acknowledged");
    expect((await rows(t))[0]!.threadId).toBe(testThreadId(7));
  });

  it("reconciles an abandoned intent when exactly one thread matches", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.abandonDirectAttempt, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1",
    });
    const one = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 1, threadId: testThreadId(8),
    });
    expect(one.state).toBe("reconciled");
    expect(one.threadId).toBe(testThreadId(8));
  });

  it("settles a unique match only while the original credential namespace is current", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));

    // The bounded search found one match, but a reconnect landed before the
    // observation was persisted. The old namespace's evidence cannot settle
    // an attempt under a new one, and the attempt must not be re-dispatched.
    await t.run(async (ctx) => {
      ctx.db.patch(connectionId, { credentialVersion: 2, updatedAt: Date.now() });
    });
    const rec = await t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      attemptId: "intent-1",
      matchCount: 1,
      threadId: testThreadId(9),
      expectedCredentialVersion: 1,
      expectedOwnerRevision: 1,
    });
    expect(rec.safeToProceed).toBe(false);
    expect(rec.threadId).toBe(null);
    expect(rec.bindingCurrent).toBe(false);
    expect(rec.state).toBe("ambiguous");
    expect(rec.note).toMatch(/credential namespace/);

    const row = (await rows(t))[0]!;
    expect(row.state).toBe("ambiguous");
    expect(row.threadId).toBe(null);
    expect(row.matchCount).toBe(0);
  });

  it("rejects contradictory reconciliation evidence", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));
    await t.mutation(internal.directLaunchAttempts.markDirectDispatching, claimArgs(connectionId));
    await expect(
      t.mutation(internal.directLaunchAttempts.recordDirectReconciliation, {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, attemptId: "intent-1", matchCount: 2, threadId: testThreadId(1),
      }),
    ).rejects.toThrow(/disagree/);
  });
});

describe("directLaunchAttempts: legacy issue-bound ledger stays intact", () => {
  it("does not share rows, locks or indexes with launchAttempts (B7)", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await insertConnection(t);
    await t.mutation(internal.directLaunchAttempts.reserveDirectLaunch, reserveArgs(connectionId));

    // The issue-bound reservation path is unchanged and unaffected by the
    // direct row: same issue key and attempt id space stays independent.
    const legacy = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-1",
      issueIdentifier: "EGA-681",
      attemptId: "intent-1",
      payloadHash: PAYLOAD_A,
    });
    expect(legacy.state).toBe("prepared");
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "intent-1",
      threadId: testThreadId(3),
      at,
    });
    const legacyRows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.issueKey).toBe("issue-1");
    expect(await rows(t)).toHaveLength(1);
    expect((await rows(t))[0]!.state).toBe("prepared");
  });
});

describe("directLaunchAttempts: unclaimed-race outcome mapping", () => {
  it("reports a durable settled thread instead of a blanket in-progress", () => {
    expect(classifyUnclaimedAttempt({ state: "acknowledged", threadId: testThreadId(1) })).toEqual({
      kind: "settled",
      threadId: testThreadId(1),
    });
    expect(classifyUnclaimedAttempt({ state: "reconciled", threadId: testThreadId(2) })).toEqual({
      kind: "settled",
      threadId: testThreadId(2),
    });
    expect(classifyUnclaimedAttempt({ state: "abandoned", threadId: null })).toEqual({ kind: "abandoned" });
    expect(classifyUnclaimedAttempt({ state: "dispatching", threadId: null })).toEqual({ kind: "in_progress" });
    // A durable ambiguous state must not be reported as "in progress": the
    // caller has to reconcile, not wait.
    expect(classifyUnclaimedAttempt({ state: "ambiguous", threadId: null })).toEqual({ kind: "ambiguous" });
    expect(classifyUnclaimedAttempt(null)).toEqual({ kind: "in_progress" });
    // A settled row without a thread is contradictory; never report it as
    // proof of a launch.
    expect(classifyUnclaimedAttempt({ state: "acknowledged", threadId: null })).toEqual({ kind: "in_progress" });
  });
});
