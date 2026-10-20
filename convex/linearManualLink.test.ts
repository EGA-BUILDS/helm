/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    vi.unstubAllGlobals();
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
    expect(ledger).toMatchObject({ state: "linked", attemptCount: 0 });
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

  it("N11: eleven reassignments cannot produce a second active binding (EGA-763)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const first = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));
    let current = first.associationId;
    // Each reassignment leaves a tombstone, so the thread accumulates rows. A
    // windowed lookup loses the ACTIVE row once the window is all tombstones,
    // which is exactly how a manual link used to be able to create a second
    // active binding for one thread.
    for (let i = 0; i < 11; i += 1) {
      const target = i % 2 === 0 ? ISSUE_ID_2 : ISSUE_ID;
      const next = await authed.action(api.linearManualLink.reassign, {
        ...baseArgs(testThreadId(1), target),
        expectedAssociationId: current,
      });
      current = next.associationId;
    }
    const active = await t.run(async (ctx) =>
      (await ctx.db.query("linearIssueThreads").collect()).filter((row) => row.unlinkedAt === 0));
    expect(active, "a thread must never hold two active bindings").toHaveLength(1);
    // The loop ends bound to ISSUE_ID_2, so re-linking the SAME issue is an
    // idempotent no-op...
    const again = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID_2));
    expect(again.created).toBe(false);
    // ...while linking a DIFFERENT issue must still SEE the binding and refuse
    // (as a reassignment needing an explicit expected association id) rather
    // than silently creating a second active one.
    await expect(
      authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID)),
    ).rejects.toThrow(/expected association id|confirm/i);
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
    const linked = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const assocId = linked.find((r) => r.t3ThreadId === testThreadId(7))?.associationId;
    await authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(7),
      confirm: true,
      expectedAssociationId: assocId,
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

  it("internal link with stale/absent owner is unauthorized", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await expect(t.mutation(internal.linearManualLinkStore.link, {
      subject: "someone-else", ownerIssuer: OWNER_ISSUER, revision: 1,
      ...baseArgs(testThreadId(1)),
    })).rejects.toThrow(/unauthorized/);
    const t2 = convexTest(schema, modules);
    await expect(t2.mutation(internal.linearManualLinkStore.link, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      ...baseArgs(testThreadId(2)),
    })).rejects.toThrow(/unauthorized/);
  });


  it("F6: unlink with stale/absent owner is unauthorized", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    const linked = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const assocId = linked.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await expect(t.mutation(internal.linearManualLinkStore.unlink, {
      subject: "someone-else", ownerIssuer: OWNER_ISSUER, revision: 1,
      t3ThreadId: testThreadId(1), confirm: true, expectedAssociationId: assocId,
    })).rejects.toThrow(/unauthorized/);
    const t2 = convexTest(schema, modules);
    await expect(t2.mutation(internal.linearManualLinkStore.unlink, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      t3ThreadId: testThreadId(1), confirm: true, expectedAssociationId: assocId,
    })).rejects.toThrow(/unauthorized/);
  });

  it("M6: unlink without expectedAssociationId is refused", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await expect(authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(1), confirm: true,
    })).rejects.toThrow(/expected association/i);
  });

  it("M8/F9: a tombstoned binding cannot be resurrected by a launch retry", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    const linked = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const assocId = linked.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(1), confirm: true, expectedAssociationId: assocId,
    });
    // seed an accepted attempt for the same (issue, thread)
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-res", issueKey: ISSUE_ID, issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:x]", state: "acknowledged",
      threadId: testThreadId(1), dispatchedAt: at, acknowledgedAt: at + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    await expect(authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-res", threadId: testThreadId(1),
    })).rejects.toThrow(/unlinked|cannot be re-associated/i);
  });

  it("M4: reassigning a launch-derived association requires confirmLaunchEvidenceLoss", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-ld", issueKey: ISSUE_ID, issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:x]", state: "acknowledged",
      threadId: testThreadId(1), dispatchedAt: at, acknowledgedAt: at + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const rec = await authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-ld", threadId: testThreadId(1),
    });
    await expect(authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2),
      expectedAssociationId: rec.associationId,
      confirm: true,
    })).rejects.toThrow(/launch evidence/i);
  });

  it("M5: an empty attemptId row is adopted/upgraded by a later launch", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-adopt", issueKey: ISSUE_ID, issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:x]", state: "acknowledged",
      threadId: testThreadId(1), dispatchedAt: at, acknowledgedAt: at + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    const rec = await authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-adopt", threadId: testThreadId(1),
    });
    expect(rec.created).toBe(false);
    const rows = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const row = rows.find((r) => r.t3ThreadId === testThreadId(1));
    expect(row?.attemptId).toBe("attempt-adopt");
  });

  it("N1: two tombstones then a launch leaves exactly one active binding", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1), ISSUE_ID));
    const r1 = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const a1 = r1.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2), confirm: true, expectedAssociationId: a1,
    });
    const r2 = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID_2 });
    const a2 = r2.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), "issue-uuid-3"), confirm: true, expectedAssociationId: a2,
    });
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-N1", issueKey: "issue-uuid-4", issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:x]", state: "acknowledged",
      threadId: testThreadId(1), dispatchedAt: at, acknowledgedAt: at + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    await expect(authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: "issue-uuid-4",
      attemptId: "attempt-N1", threadId: testThreadId(1),
    })).rejects.toThrow();
    const active = await t.run(async (ctx) => {
      const rows = await ctx.db.query("linearIssueThreads")
        .withIndex("by_owner_thread", (q) => q.eq("ownerSubject", OWNER_SUBJECT).eq("ownerIssuer", OWNER_ISSUER).eq("t3ThreadId", testThreadId(1))).collect();
      return rows.filter((r) => r.unlinkedAt === 0);
    });
    expect(active).toHaveLength(1);
  });

  it("safety net: link/reassign/unlink make zero network calls", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    const linked = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID });
    const assocId = linked.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await authed.action(api.linearManualLink.reassign, {
      ...baseArgs(testThreadId(1), ISSUE_ID_2), confirm: true, expectedAssociationId: assocId,
    });
    const linked2 = await t.query(internal.linearAssociationStore.associationsForIssue, { ...owner, linearIssueId: ISSUE_ID_2 });
    const assocId2 = linked2.find((r) => r.t3ThreadId === testThreadId(1))?.associationId;
    await authed.action(api.linearManualLink.unlink, {
      t3ThreadId: testThreadId(1), confirm: true, expectedAssociationId: assocId2,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("import-closure guard: manual link module does not reach T3 launch/OAuth/dispatch/linear helpers", () => {
    const src = readFileSync(join(process.cwd(), "convex", "linearManualLinkStore.ts"), "utf8");
    expect(src).not.toMatch(/t3Launch|t3OAuth|dispatch|lib\/linear/);
  });

  it("import-closure guard: manual link action module does not reach T3 launch/OAuth/dispatch/linear helpers", () => {
    const src = readFileSync(join(process.cwd(), "convex", "linearManualLink.ts"), "utf8");
    expect(src).not.toMatch(/t3Launch|t3OAuth|dispatch|lib\/linear/);
  });

  // ---------------------------------------------------------------------------
  // readAssociation (EGA-763): read-only current binding for the UI.
  // ---------------------------------------------------------------------------

  it("R1: readAssociation is owner-gated and rejects an anonymous or non-owner caller", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await t2Rejects(t3);
  });

  async function t2Rejects(t3: Id<"t3Connections">) {
    // no grant at all -> no identity -> denied
    const t2 = convexTest(schema, modules);
    await expect(t2.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    })).rejects.toThrow(/unauthorized/i);
  }

  it("R-gated: readAssociation rejects a caller whose identity is not the owner", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    const stranger = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(stranger.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    })).rejects.toThrow(/unauthorized/i);
  });

  it("R2: readAssociation returns the active association with id, issue identity and provenance", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const linked = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));

    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    });
    expect(res.association).not.toBeNull();
    if (res.association === null) throw new Error("association should exist");
    expect(res.association.associationId).toBe(linked.associationId);
    expect(res.association).toMatchObject({
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-763",
      provenance: "manual",
    });
    expect(typeof res.association.createdAt).toBe("number");
  });

  it("R2b: readAssociation reports provenance launch after a launch adopts the binding", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-read", issueKey: ISSUE_ID, issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:x]", state: "acknowledged",
      threadId: testThreadId(1), dispatchedAt: at, acknowledgedAt: at + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    await authed.action(api.linearAssociation.recordFromLaunch, {
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-read", threadId: testThreadId(1),
    });
    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    });
    expect(res.association && res.association.provenance).toBe("launch");
  });

  it("R3: readAssociation returns null when the thread has no association", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(8),
    });
    expect(res.association).toBeNull();
  });

  it("R3b: readAssociation never returns another owner's association row", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    // A row owned by someone else (seeded directly; there is no second configured owner).
    await t.run(async (ctx) => await ctx.db.insert("linearIssueThreads", {
      ownerSubject: "intruder-subject",
      ownerIssuer: "https://intruder.example",
      ownerRevision: 1,
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-763",
      t3ConnectionId: t3,
      t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1",
      t3ThreadId: testThreadId(9),
      attemptId: "",
      correlationKey: "",
      unlinkedAt: 0,
      createdAt: at,
    }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(9),
    });
    expect(res.association).toBeNull();
  });

  it("R4: readAssociation refuses a thread bound under a different connection", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const otherConn = await seedT3Connection(t, "env-2");
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    await expect(authed.action(api.linearManualLink.readAssociation, {
      connectionId: String(otherConn), projectId: "proj-1", threadId: testThreadId(1),
    })).rejects.toThrow(/already associated under a different connection/i);
  });

  it("R5: readAssociation creates nothing: association and ledger row counts are unchanged", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));

    const count = async () => await t.run(async (ctx) => ({
      threads: (await ctx.db.query("linearIssueThreads").collect()).length,
      ledger: (await ctx.db.query("linearSyncLedger").collect()).length,
      launches: (await ctx.db.query("launchAttempts").collect()).length,
    }));
    const before = await count();

    await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    });
    // A read of an unbound thread must not create anything either.
    await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(8),
    });

    const after = await count();
    expect(after).toEqual(before);
  });

  it("R6: readAssociation contract returns every field the UI decoder requires", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const linked = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));

    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    });
    expect(res.association).not.toBeNull();
    if (res.association === null) throw new Error("association should exist");
    // The declared returns validator must accept a row carrying every field
    // the UI decoder (decodeAssociation) requires; the action call above
    // already enforced the validator at runtime.
    expect(res.association).toMatchObject({
      associationId: linked.associationId,
      linearWorkspaceId: "ws-1",
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID,
      linearIssueIdentifier: "EGA-763",
      t3ConnectionId: String(t3),
      t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1",
      t3ThreadId: testThreadId(1),
      attemptId: "",
      correlationKey: "",
      unlinkedAt: 0,
      provenance: "manual",
    });
    expect(typeof res.association.createdAt).toBe("number");
    expect(typeof res.association.note).not.toBe("undefined");
  });

  it("mutation proof: replacing the exact index lookup with a windowed scan fails R2-retry", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const first = await authed.action(api.linearManualLink.link, baseArgs(testThreadId(1)));
    // Eleven tombstones push any windowed scan past the active row: a window
    // (ascending take + tombstone filter) sees only dead rows and wrongly
    // reports "no association". The exact indexed lookup with
    // eq(unlinkedAt, 0) still finds the single active binding.
    let current = first.associationId;
    for (let i = 0; i < 11; i += 1) {
      const target = i % 2 === 0 ? ISSUE_ID_2 : ISSUE_ID;
      const next = await authed.action(api.linearManualLink.reassign, {
        ...baseArgs(testThreadId(1), target),
        expectedAssociationId: current,
      });
      current = next.associationId;
    }
    const res = await authed.action(api.linearManualLink.readAssociation, {
      connectionId: t3, projectId: "proj-1", threadId: testThreadId(1),
    });
    expect(res.association && res.association.associationId).toBe(current);
  });

  it("mutation proof: replacing the exact index lookup with a windowed scan fails the source guard", () => {
    // The shared helper currentAssociationForThread serves BOTH the mutation
    // path and the read path; this guard pins its exact indexed shape so a
    // windowed scan cannot be reintroduced on either side.
    const src = readFileSync(join(process.cwd(), "convex", "linearManualLinkStore.ts"), "utf8");
    const start = src.indexOf("async function currentAssociationForThread");
    const end = src.indexOf("async function deleteLedgerRows");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("by_owner_thread_unlinked");
    expect(body).toMatch(/eq\("unlinkedAt",\s*0\)/);
    expect(body).toMatch(/\.take\(2\)/);
    expect(body).toContain("T3 thread has more than one active association");
    expect(body).not.toMatch(/order\("desc"\)/);
  });

  it("mutation proof: dropping the owner check fails R-stale", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    // With requireCurrentOwnerGrant dropped, a caller presenting a stale
    // (previously-valid) revision would pass; the real lookup denies it.
    await expect(t.query(internal.linearManualLinkStore.readAssociation, {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 999,
      connectionId: String(t3), projectId: "proj-1", threadId: testThreadId(8),
    })).rejects.toThrow(/unauthorized|stale/i);
  });

});
