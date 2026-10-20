/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * EGA-762: the canonical Linear issue <-> native T3 thread association store.
 *
 * Exercised through the generated api references over convex-test — no
 * network is involved in this suite at all. Under test: association is
 * recorded only from an ACCEPTED (acknowledged/reconciled) launch attempt,
 * idempotently on the (owner, issue, thread) pair; intentional second threads
 * coexist without displacing the first; foreign owners, wrong connections,
 * and unmatched threads/issues are refused.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");

const at = 1_700_000_000_000;
const ISSUE_ID = "issue-uuid-1";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("linear association store", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;

  beforeEach(() => {
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

  async function seedT3Connection(t: ReturnType<typeof convexTest>): Promise<Id<"t3Connections">> {
    return await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp",
      issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp",
      clientId: "helm-test-client",
      environmentId: "env-1",
      environmentLabel: "Studio",
      serverVersion: "1.0.0",
      platform: "linux/x64",
      access: "operate",
      status: "connected",
      tokenCiphertext: "v1.token.placeholder.placeholder",
      credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastVerifiedAt: null,
      lastSuccessfulReadAt: null,
      lastErrorCode: null,
    }));
  }

  /** Seeds the enabled mapping that both recordFromLaunch and syncIssue resolve. */
  async function seedMapping(
    t: ReturnType<typeof convexTest>,
    t3ConnectionId: Id<"t3Connections">,
    overrides: Record<string, string> = {},
  ): Promise<Id<"linearProjectMappings">> {
    return await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner,
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearProjectName: "Helm",
      linearTeamId: "team-eng",
      linearTeamKey: "ENG",
      linearTeamName: "Engineering",
      t3ConnectionId,
      t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1",
      t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main",
      targetBranch: "main",
      startedStateId: "s-progress",
      startedStateName: "In Progress",
      at: Date.now(),
      ...overrides,
    });
  }

  /** Durably seeds an ALREADY COMPLETED launch attempt (as t3Launch would). */
  async function seedAcceptedAttempt(
    t: ReturnType<typeof convexTest>,
    args: { issueKey: string; attemptId: string; threadId: string; state?: string; targetProjectId?: string | null },
  ): Promise<Id<"launchAttempts">> {
    return await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: args.attemptId,
      issueKey: args.issueKey,
      issueIdentifier: "EGA-762",
      payloadHash: "a".repeat(64),
      correlationKey: `[helm:${args.issueKey}:testcorr${args.attemptId}]`,
      state: (args.state ?? "acknowledged") as "acknowledged",
      threadId: args.threadId,
      dispatchedAt: at,
      acknowledgedAt: at + 1,
      matchCount: null,
      ...(args.targetProjectId === null ? {} : { targetProjectId: args.targetProjectId ?? "t3-proj-1" }),
    }));
  }

  async function associationsOf(t: ReturnType<typeof convexTest>) {
    return await t.query(internal.linearAssociationStore.associationsForIssue, {
      ...owner, linearIssueId: ISSUE_ID,
    });
  }

  function record(t: ReturnType<typeof convexTest>, overrides: Record<string, string> = {}) {
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      attemptId: "attempt-1",
      threadId: testThreadId(1),
      ...overrides,
    });
  }

  const fullIdentity = {
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: ISSUE_ID,
    linearIssueIdentifier: "EGA-762",
    t3EnvironmentId: "env-1",
    t3ProjectId: "t3-proj-1",
    attemptId: "attempt-1",
  };

  it("records one association for an accepted launch with stable ids on both sides", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });

    const result = await record(t);
    expect(result.created).toBe(true);
    const rows = await associationsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...fullIdentity,
      t3ConnectionId: t3,
      t3ThreadId: testThreadId(1),
      correlationKey: `[helm:${ISSUE_ID}:testcorrattempt-1]`,
    });

    // The companion ledger row starts pending with zero attempts.
    const ledger = await t.query(internal.linearAssociationStore.ledgerForAssociation, {
      ...owner, associationId: result.associationId,
    });
    expect(ledger).toMatchObject({ state: "pending", attemptCount: 0, targetStateId: null });
  });

  it("is idempotent: a retry records nothing new for the same (issue, thread) pair", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });

    const first = await record(t);
    const second = await record(t);
    expect(second.created).toBe(false);
    expect(second.associationId).toBe(first.associationId);
    expect(await associationsOf(t)).toHaveLength(1);

    // The ledger row is also not duplicated or rewound.
    const ledger = await t.query(internal.linearAssociationStore.ledgerForAssociation, {
      ...owner, associationId: first.associationId,
    });
    expect(ledger?.state).toBe("pending");
    expect(ledger?.attemptCount).toBe(0);
  });

  it("lets two intentional threads for one issue coexist without displacing each other", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    const first = await record(t);
    // A second accepted launch for the SAME issue, different thread.
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-2", threadId: testThreadId(2) });
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const second = await authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-2", threadId: testThreadId(2),
    });
    expect(second.created).toBe(true);

    const rows = await associationsOf(t);
    expect(rows).toHaveLength(2);
    const byThread = new Map(rows.map((row) => [row.t3ThreadId, row]));
    expect(byThread.get(testThreadId(1))).toMatchObject({ ...fullIdentity, attemptId: "attempt-1", t3EnvironmentId: "env-1" });
    expect(byThread.get(testThreadId(2))).toMatchObject({ ...fullIdentity, attemptId: "attempt-2", t3EnvironmentId: "env-1" });
    expect(first.associationId).not.toBe(second.associationId);
  });

  it("also records a RECONCILED (recovered) launch, but nothing else", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1), state: "reconciled" });
    const result = await record(t);
    expect(result.created).toBe(true);

    for (const state of ["prepared", "dispatching", "ambiguous", "abandoned"] as const) {
      const t2 = await granted();
      const t3b = await seedT3Connection(t2);
      await seedMapping(t2, t3b);
      await seedAcceptedAttempt(t2, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(3), state });
      await expect(record(t2, { threadId: testThreadId(3) })).rejects.toThrow(
        /only accepted \(acknowledged\/reconciled\) launches/,
      );
      expect(await t2.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
    }
  });

  it("refuses an attempt that cannot be found", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await expect(record(t)).rejects.toThrow(/could not be found/);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
  });

  it("refuses when the attempt belongs to a different issue or a different thread", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    await expect(record(t, { linearIssueId: "issue-uuid-2" })).rejects.toThrow(/different Linear issue/);
    await expect(record(t, { threadId: testThreadId(9) })).rejects.toThrow(/different T3 thread/);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
  });

  it("a thread is bound to exactly one issue", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    await record(t);
    await seedAcceptedAttempt(t, { issueKey: "issue-uuid-2", attemptId: "attempt-2", threadId: testThreadId(1) });
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: "issue-uuid-2",
      attemptId: "attempt-2", threadId: testThreadId(1),
    })).rejects.toThrow(/already associated with issue/);
    const rows = await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect());
    expect(rows).toHaveLength(1);
  });

  it("refuses when the mapping is missing for the issue's team", async () => {
    const t = await granted();
    await expect(record(t)).rejects.toThrow(/No enabled mapping/);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
  });

  it("the mapping half is bound to the launch's recorded T3 target project (F2)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    // The mapping resolves to t3-proj-1; the attempt was durably recorded
    // against a DIFFERENT T3 project. The attempt's issue/thread evidence is
    // genuinely unforgeable, so the only forgery surface left is which
    // mapping the caller names — and this check closes it.
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1), targetProjectId: "t3-proj-OTHER" });
    await expect(record(t)).rejects.toThrow(/targeted a different T3 project/);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
  });

  it("a legacy attempt row with no recorded T3 target project is refused (F2)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1), targetProjectId: null });
    await expect(record(t)).rejects.toThrow(/targeted a different T3 project/);
    expect(await t.run(async (ctx) => await ctx.db.query("linearIssueThreads").collect())).toHaveLength(0);
  });

  it("refuses stable-identity drift on an existing association instead of rewriting it", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    // Create the original mapping and record.
    await record(t);
    const before = await associationsOf(t);
    // A second mapping for the same pair is impossible (one enabled row per
    // pair), so drift is exercised at the store level: same pair, different
    // T3 project id.
    await expect(t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner,
      ...fullIdentity,
      t3ConnectionId: t3,
      t3EnvironmentId: "env-2",
      t3ThreadId: testThreadId(1),
      correlationKey: `[helm:${ISSUE_ID}:testcorrattempt-1]`,
      at: Date.now(),
    })).rejects.toThrow(/different stable identity/);
    expect(await associationsOf(t)).toEqual(before);
  });

  it("cross-owner reaches are refused", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    const result = await record(t);

    // A foreign subject's grant exists in the table but belongs to nobody
    // current: every read refuses or returns null.
    const foreignId = await t.run(async (ctx) => await ctx.db.insert("linearIssueThreads", {
      ownerSubject: "someone-else",
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      ...fullIdentity,
      t3ConnectionId: t3,
      t3ThreadId: testThreadId(5),
      correlationKey: "[helm:foreign:1]",
      createdAt: at,
    }));
    expect((await associationsOf(t)).map((row) => row.associationId)).toEqual([result.associationId]);
    await expect(t.query(internal.linearAssociationStore.ledgerForAssociation, {
      ...owner, associationId: foreignId,
    })).resolves.toBe(null);
    expect(await t.query(internal.linearAssociationStore.associationForThread, {
      ...owner, t3ConnectionId: t3, t3ThreadId: testThreadId(5),
    })).toBe(null);
    // The foreign owner cannot even pass the internal gate.
    await expect(t.mutation(internal.linearAssociationStore.ensureAssociation, {
      subject: "someone-else", ownerIssuer: OWNER_ISSUER, revision: 1,
      ...fullIdentity, t3ConnectionId: t3, t3ThreadId: testThreadId(6),
      correlationKey: "[helm:foreign:2]", at: Date.now(),
    })).rejects.toThrow(/unauthorized/);
  });

  it("cross-connection reaches are refused: the lookup binds the T3 connection", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    await record(t);
    // A second, DIFFERENT connection the owner also controls.
    const otherConnection = await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp",
      issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp",
      clientId: "helm-test-client",
      environmentId: "env-2",
      environmentLabel: "Other",
      serverVersion: "1.0.0",
      platform: "linux/x64",
      access: "operate",
      status: "connected",
      tokenCiphertext: "v1.token.placeholder.placeholder",
      credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastVerifiedAt: null,
      lastSuccessfulReadAt: null,
      lastErrorCode: null,
    }));
    expect(await t.query(internal.linearAssociationStore.associationForThread, {
      ...owner, t3ConnectionId: otherConnection, t3ThreadId: testThreadId(1),
    })).toBe(null);
    expect(await t.query(internal.linearAssociationStore.associationForThread, {
      ...owner, t3ConnectionId: t3, t3ThreadId: testThreadId(1),
    })).toMatchObject({ associationId: expect.anything(), t3ThreadId: testThreadId(1) });
  });

  it("anonymous and non-owner callers cannot record associations", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedAcceptedAttempt(t, { issueKey: ISSUE_ID, attemptId: "attempt-1", threadId: testThreadId(1) });
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-1", threadId: testThreadId(1),
    })).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-1", threadId: testThreadId(1),
    })).rejects.toThrow(/unauthorized/);
    await expect(authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-1", threadId: testThreadId(1),
    })).resolves.toMatchObject({ created: true });
  });
});
