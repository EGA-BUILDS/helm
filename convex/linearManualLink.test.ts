/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");

const at = 1_700_000_000_000;
const ISSUE_ID = "issue-uuid-1";
const ISSUE_ID_2 = "issue-uuid-2";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("linear manual link", () => {
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

  async function seedT3Connection(t: ReturnType<typeof convexTest>, env = "env-1"): Promise<Id<"t3Connections">> {
    return await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT,
      ownerIssuer: OWNER_ISSUER,
      ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp",
      issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp",
      clientId: "helm-test-client",
      environmentId: env,
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

  async function seedMapping(t: ReturnType<typeof convexTest>, t3ConnectionId: Id<"t3Connections">, overrides: Record<string, unknown> = {}) {
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

  const baseArgs = (threadId: string, issueId = ISSUE_ID) => ({
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: issueId,
    linearIssueIdentifier: "EGA-763",
    t3ThreadId: threadId,
    confirm: true,
  });

  it("links a thread with no prior association: one association, no launch, ledger pending", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const beforeLaunches = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());

    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    expect(result.created).toBe(true);

    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ linearIssueId: ISSUE_ID, t3ThreadId: testThreadId(1), t3ConnectionId: t3, attemptId: "", correlationKey: "" });

    const afterLaunches = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(afterLaunches).toHaveLength(beforeLaunches.length);

    const ledger = await t.query(internal.linearAssociationStore.ledgerForAssociation, { ...owner, associationId: result.associationId });
    expect(ledger).toMatchObject({ state: "pending", attemptCount: 0 });
  });

  it("linking a thread already bound to an issue requires confirmation and never silently rebinds", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));

    // No confirm: refused, no new binding.
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2),
      confirm: false,
    })).rejects.toThrow(/confirmation/i);

    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    expect(rows).toHaveLength(1);
    const rows2 = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID_2 });
    expect(rows2).toHaveLength(0);
  });

  it("reassignment with stale expected association fails with a conflict and no write", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const first = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));
    // reassign to issue2 with wrong expected id
    await expect(authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2),
      expectedAssociationId: "bogus",
    })).rejects.toThrow(/conflict/i);
    // still bound to issue1
    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    expect(rows).toHaveLength(1);
    const rows2 = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID_2 });
    expect(rows2).toHaveLength(0);
    void first;
  });

  it("two competing reassignments: exactly one wins, loser gets conflict", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const first = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));
    // First reassignment succeeds.
    await authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2),
      expectedAssociationId: first.associationId,
    });
    // A stale retry using the old association id now fails.
    await expect(authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID),
      expectedAssociationId: first.associationId,
    })).rejects.toThrow(/conflict/i);
  });

  it("refuses wrong connection / project / workspace / team / issue", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const otherConn = await seedT3Connection(t, "env-2");
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });

    // wrong connection (via override) -> mismatch
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(2)),
      t3ConnectionId: otherConn,
    })).rejects.toThrow(/connection/i);

    // wrong project
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(3)),
      linearProjectId: "proj-2",
    })).rejects.toThrow(/mapping|project/i);

    // wrong team
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(4)),
      linearTeamId: "team-other",
    })).rejects.toThrow(/mapping|team/i);

    // wrong workspace
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(5)),
      linearWorkspaceId: "ws-other",
    })).rejects.toThrow(/workspace/i);

    // wrong environment
    await expect(authed.action(api.linearManualLink.link, {
      ...baseArgs(testThreadId(6)),
      t3EnvironmentId: "env-other",
    })).rejects.toThrow(/environment/i);
  });

  it("unlink requires confirmation and removes only the association (launch attempt preserved)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    // seed a launch attempt to prove preservation
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-preserve",
      issueKey: ISSUE_ID,
      issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64),
      correlationKey: "[helm:x]",
      state: "acknowledged",
      threadId: testThreadId(7),
      dispatchedAt: at,
      acknowledgedAt: at + 1,
      matchCount: null,
      targetProjectId: "t3-proj-1",
    }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(7)));

    // no confirm -> refused
    await expect(authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(7),
      confirm: false,
    })).rejects.toThrow(/confirmation/i);

    const beforeAttempts = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    await authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(7),
      confirm: true,
    });
    const afterAttempts = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(afterAttempts).toHaveLength(beforeAttempts.length);

    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    // the unlinked thread's row is gone (issue may have zero rows now)
    const threadRows = rows.filter((r) => r.t3ThreadId === testThreadId(7));
    expect(threadRows).toHaveLength(0);
  });

  it("multiple threads on one issue coexist after a manual link", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(2)));
    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    expect(rows).toHaveLength(2);
  });

  it("mutation-prove: removing the concurrency check fails the stale-reassignment test", async () => {
    // Behavioral witness: a stale expected id is refused even when confirm is true.
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const first = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await authed.action(api.linearManualLink.reassign, { ...baseArgs(testThreadId(1), ISSUE_ID_2), expectedAssociationId: first.associationId });
    await expect(authed.action(api.linearManualLink.reassign, { ...baseArgs(testThreadId(1), ISSUE_ID), expectedAssociationId: first.associationId })).rejects.toThrow(/conflict/i);
  });

  it("mutation-prove: removing owner/identity validation allows anonymous mutation to be refused", async () => {
    const t = await granted();
    const modules = import.meta.glob("./**/*.ts");
    const t2 = convexTest(schema, modules);
    await expect(t2.action(api.linearManualLink.link, baseArgs(testThreadId(1)))).rejects.toThrow(/unauthorized/);
    void t;
  });

  it("mutation-prove: removing the confirmation gate allows unconfirmed reassignment to succeed (must not)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));
    await expect(authed.action(api.linearManualLink.link, { ...baseArgs(testThreadId(1), ISSUE_ID_2), confirm: false })).rejects.toThrow(/confirmation/i);
  });
});
