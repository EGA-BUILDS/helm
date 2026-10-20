/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "./schema";
import { LINEAR_ISSUE_DETAIL_QUERY } from "./lib/linearIssues";
import { LINEAR_TEAM_STATES_QUERY } from "./lib/linearGraphql";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";
import { retryBackoffMs } from "./linearSync";

/**
 * B3: the product trigger for the Linear sync (EGA-762).
 *
 * The feature under test is the PAIR of automatic drivers:
 *
 *   - the launch trigger (`t3Launch` -> `ctx.scheduler.runAfter` ->
 *     `linearSync.runScheduledSync`), and
 *   - the periodic driver (`convex/crons.ts` -> `linearSync.driveRetryable`).
 *
 * Every test here is DISCRIMINATING: it fails when the mechanism it names is
 * removed. That is the point — the previous round's tests passed with the
 * manual filter deleted and with the attempt bound deleted.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };
const modules = import.meta.glob("./**/*.ts");
const ISSUE_ID = "issue-uuid-1";
const LINEAR_GRAPHQL_HOST = "https://api.linear.app/graphql";

/** The cron tick, in minutes. Every rung of the ladder is above it. */
const CRON_TICK_MINUTES = 5;

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function issuePayload(issueId = ISSUE_ID, stateId = "s-backlog"): unknown {
  const state = stateId === "s-progress"
    ? { id: "s-progress", name: "In Progress", type: "started" }
    : { id: "s-backlog", name: "Backlog", type: "unstarted" };
  return {
    data: {
      organization: { id: "ws-1" },
      issue: {
        id: issueId, identifier: "EGA-762", title: "Linear sync", url: "u", priority: 2, priorityLabel: "High",
        description: null, state, team: { id: "team-eng", key: "ENG", name: "Engineering" },
        project: { id: "proj-1" }, assignee: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

const TEAM_STATES_ENG = {
  data: { team: { id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
    states: { nodes: [
      { id: "s-backlog", name: "Backlog", type: "unstarted" },
      { id: "s-progress", name: "In Progress", type: "started" },
    ] } } },
};

describe("linear sync trigger (B3)", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;
  let savedKeyVersion: string | undefined;
  let savedKeyV1: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    savedKeyVersion = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION;
    savedKeyV1 = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("y".repeat(32)).toString("base64");
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT; else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL; else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
    if (savedKeyVersion === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION; else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = savedKeyVersion;
    if (savedKeyV1 === undefined) delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1; else process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = savedKeyV1;
    vi.unstubAllGlobals();
  });

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  /**
   * A Linear stub whose issue MOVES to In Progress once the write lands, so
   * the `synced` path (observed truth after the write) is actually
   * exercised. Without the move the post-write re-read still shows Backlog
   * and the row stays `retryable` — which is how the previous round's tests
   * never reached `synced`.
   */
  function installLinearStub(options: { moveOnWrite?: boolean; mutationStatus?: number } = {}) {
    const calls = { detail: 0, states: 0, mutation: 0 };
    // One state PER ISSUE: a bulk run drives several issues, and each of them
    // has to reach `synced` on its own.
    const states = new Map<string, string>();
    const fetchStub = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url = String(input);
      if (url !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected network target: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: { issueId?: string } };
      const issueId = body.variables?.issueId ?? ISSUE_ID;
      if (body.query.startsWith("mutation")) {
        calls.mutation += 1;
        if (options.moveOnWrite) states.set(issueId, "s-progress");
        const status = options.mutationStatus ?? 200;
        if (status !== 200) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_TEAM_STATES_QUERY) {
        calls.states += 1;
        return new Response(JSON.stringify(TEAM_STATES_ENG), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_ISSUE_DETAIL_QUERY || body.query.includes("issue(id:")) {
        calls.detail += 1;
        return new Response(JSON.stringify(issuePayload(issueId, states.get(issueId) ?? "s-backlog")), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected Linear query: ${body.query.slice(0, 60)}`);
    };
    vi.stubGlobal("fetch", fetchStub);
    return calls;
  }

  async function seedT3Connection(t: ReturnType<typeof convexTest>): Promise<Id<"t3Connections">> {
    return await t.run(async (ctx) => ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client", environmentId: "env-1",
      environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64", access: "operate",
      status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder", credentialVersion: 1,
      expiresAt: Date.now() + 24 * 60 * 60_000, createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
  }

  async function seedMapping(t: ReturnType<typeof convexTest>, t3ConnectionId: Id<"t3Connections">) {
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main", startedStateId: "s-progress",
      startedStateName: "In Progress", at: Date.now(),
    });
  }

  async function seedLinearConnection(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null, credentialVersion: 1, scopes: ["read", "write"],
      status: "connected", lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
  }

  /** A launch-derived association (the automatic drivers may own it). */
  async function seedLaunchAssociation(t: ReturnType<typeof convexTest>, t3ConnectionId: Id<"t3Connections">) {
    return await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-762", t3ConnectionId, t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(1), attemptId: "attempt-1",
      correlationKey: `[helm:${ISSUE_ID}:testcorr]`, at: Date.now(),
    });
  }

  /**
   * A MANUAL association of the SAME issue (a different thread), i.e. exactly
   * the shape that used to be swept into an automatic sync: it is returned
   * by `associationsForIssue` next to the launch-derived one.
   */
  async function seedManualAssociation(t: ReturnType<typeof convexTest>, t3ConnectionId: Id<"t3Connections">) {
    return await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-762", t3ConnectionId, t3EnvironmentId: "env-1",
      t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(2), attemptId: "",
      correlationKey: "", at: Date.now(),
    });
  }

  async function ledgerRow(t: ReturnType<typeof convexTest>, associationId: Id<"linearIssueThreads">) {
    return await t.run(async (ctx) => ctx.db
      .query("linearSyncLedger").withIndex("by_association", (q) => q.eq("associationId", associationId)).first());
  }

  function triggerArgs() {
    return {
      subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1,
      linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
    };
  }

  it("the trigger performs exactly one Linear state write and records synced from the re-read", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    const result = await t.action(internal.linearSync.runScheduledSync, triggerArgs());
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("synced");
    expect(calls.mutation).toBe(1);
    const rows = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it("running the trigger twice performs no second Linear write", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    await t.action(internal.linearSync.runScheduledSync, triggerArgs());
    const first = calls.mutation;
    const second = await t.action(internal.linearSync.runScheduledSync, triggerArgs());
    expect(calls.mutation).toBe(first);
    // The second trigger is a strict no-op: it declines because the issue is
    // already synced, and it does not even touch the ledger row.
    expect(second).toBeNull();
    const rows = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    expect(rows[0]).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it("the TRIGGER never writes a manual association's ledger row (F3/F4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const manual = await seedManualAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    // The store does NOT filter manual rows: both associations of the issue
    // are visible, so the exclusion has to happen in the automatic path.
    const all = await t.query(internal.linearAssociationStore.associationsForIssue, {
      ...owner, linearIssueId: ISSUE_ID,
    });
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.attemptId).sort()).toEqual(["", "attempt-1"]);

    const manualBefore = await ledgerRow(t, manual.associationId);
    expect(manualBefore).toMatchObject({ state: "pending", attemptCount: 0 });

    // The trigger: an automatic path.
    await t.action(internal.linearSync.runScheduledSync, triggerArgs());

    // The manual row is UNCHANGED: same attempt count, same updatedAt, same
    // state. Without the attemptId filter the trigger would have written it
    // (attemptCount 1, state synced) exactly like the launch-derived row.
    const manualAfter = await ledgerRow(t, manual.associationId);
    expect(manualAfter!.attemptCount).toBe(manualBefore!.attemptCount);
    expect(manualAfter!.updatedAt).toBe(manualBefore!.updatedAt);
    expect(manualAfter!.state).toBe(manualBefore!.state);
    // ...while the launch-derived row of the SAME issue was driven.
    expect(calls.mutation).toBe(1);
    const rows = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    const synced = rows.filter((row) => row.state === "synced");
    expect(synced).toHaveLength(1);
    expect(synced[0]!.associationId).not.toBe(manual.associationId);
  });

  it("the DRIVER never writes a manual association's ledger row (F3/F4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const manual = await seedManualAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    const manualBefore = await ledgerRow(t, manual.associationId);
    const driver = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });

    // The manual row is UNCHANGED, and the driver says WHY it left it alone.
    const manualAfter = await ledgerRow(t, manual.associationId);
    expect(manualAfter!.attemptCount).toBe(manualBefore!.attemptCount);
    expect(manualAfter!.updatedAt).toBe(manualBefore!.updatedAt);
    expect(manualAfter!.state).toBe(manualBefore!.state);
    expect(driver.skipped.manual).toBe(1);
    // The launch-derived row of the SAME issue was driven normally.
    expect(driver.processed).toBe(1);
    expect(calls.mutation).toBe(1);
  });

  it("the exclusion of manual rows is the attemptId check, not a provenance column (F4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const manual = await seedManualAssociation(t, t3);
    installLinearStub({ moveOnWrite: true });

    // EGA-763 adds a real `provenance` column to the ledger, so this tree's
    // earlier "the column does not exist" check no longer applies. The
    // property that actually matters is that the EXCLUSION is driven by the
    // association's own `attemptId` — the ledger's provenance is never
    // consulted to decide what a driver may own.
    const assoc = await t.query(internal.linearAssociationStore.associationById, {
      associationId: manual.associationId,
    });
    expect(assoc!.attemptId).toBe("");

    // Prove it BEHAVIOURALLY, which is stronger than any source grep: label
    // the manual row "launch" in the ledger and the driver must STILL leave it
    // alone, because it is the association that makes it manual.
    const row = await ledgerRow(t, manual.associationId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { provenance: "launch" });
    });
    const before = await ledgerRow(t, manual.associationId);
    await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    const after = await ledgerRow(t, manual.associationId);
    expect(after!.attemptCount).toBe(before!.attemptCount);
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.state).toBe(before!.state);
    // ...and the attemptId check must be the mechanism in both automatic paths.
    const syncSource = readFileSync(join(import.meta.dirname, "linearSync.ts"), "utf8");
    expect(syncSource).toContain('attemptId !== ""');
    expect(syncSource).toContain('attemptId === ""');
  });

  it("F2: a manual link ADOPTED by an accepted launch becomes a sync obligation again", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const calls = installLinearStub({ moveOnWrite: true });

    // Create the manual link through the REAL manual-link path, so its ledger
    // row is genuinely `linked` / `manual` -- the state no automatic driver
    // owns. (A hand-seeded row would be `pending` and would hide the defect.)
    const threadId = "mcp:00000000-0000-4000-8000-0000000000f2";
    await t.mutation(internal.linearManualLinkStore.link, {
      ...owner,
      t3ConnectionId: t3, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ThreadId: threadId,
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: ISSUE_ID, linearIssueIdentifier: "EGA-763",
    });
    const association = await t.query(internal.linearAssociationStore.associationForThread, {
      ...owner, t3ConnectionId: t3, t3ThreadId: threadId,
    });
    const manualRow = await ledgerRow(t, association!.associationId);
    expect(manualRow).toMatchObject({ state: "linked", provenance: "manual" });

    // Now an accepted launch ADOPTS the binding.
    await t.run(async (ctx) => await ctx.db.insert("launchAttempts", {
      attemptId: "attempt-adopt-f2", issueKey: ISSUE_ID, issueIdentifier: "EGA-763",
      payloadHash: "a".repeat(64), correlationKey: "[helm:f2]", state: "acknowledged",
      threadId, dispatchedAt: Date.now(), acknowledgedAt: Date.now() + 1,
      matchCount: null, targetProjectId: "t3-proj-1",
    }));
    const recorded = await t.mutation(internal.linearAssociationStore.recordFromLaunchInternal, {
      ...owner, linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: ISSUE_ID,
      attemptId: "attempt-adopt-f2", threadId,
    });
    expect(recorded).toMatchObject({ created: false, adopted: true });

    // The binding is launch-derived now, so its ledger row must be a real sync
    // obligation again -- `pending`, provenance `launch` -- not `linked`.
    const adoptedRow = await ledgerRow(t, association!.associationId);
    expect(adoptedRow).toMatchObject({ state: "pending", provenance: "launch" });

    // And the driver must own it: exactly one Linear write, and it syncs.
    const driver = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    expect(driver.processed).toBe(1);
    expect(calls.mutation).toBe(1);
    const finalRow = await ledgerRow(t, association!.associationId);
    expect(finalRow!.state).toBe("synced");
  });

  it("the TRIGGER also refuses a manual row whose ledger provenance claims launch (F4)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    // A launch-derived binding AND a manual one for the same issue: the
    // trigger drives the first, and must leave the second alone.
    await seedLaunchAssociation(t, t3);
    const manual = await seedManualAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    // LIE in the ledger: the manual row claims to be launch-derived.
    const row = await ledgerRow(t, manual.associationId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { provenance: "launch" });
    });

    // The TRIGGER must still refuse the manual binding. The exclusion is the
    // association's own `attemptId`, never the ledger's `provenance` — so a
    // wrong provenance cannot make a manual binding look launch-derived.
    await t.action(internal.linearSync.runScheduledSync, triggerArgs());

    const after = await ledgerRow(t, manual.associationId);
    expect(after!.attemptCount, "a manual binding must never be written by the trigger").toBe(row!.attemptCount);
    expect(after!.updatedAt).toBe(row!.updatedAt);
    expect(after!.state).toBe(row!.state);
    // ...while the launch-derived binding of the same issue WAS driven.
    expect(calls.mutation, "the launch-derived binding is the one that gets synced").toBe(1);
  });

  it("the periodic driver owns a `pending` row: a dropped trigger is recovered (F5)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    // The association exists with a `pending` ledger row and NO scheduled
    // trigger ever ran: this is the dropped-trigger case.
    const before = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    expect(before[0]).toMatchObject({ state: "pending", attemptCount: 0 });

    const driver = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    expect(driver.processed).toBe(1);
    expect(driver.succeeded).toBe(1);
    expect(calls.mutation).toBe(1);
    const after = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    expect(after[0]).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it("the driver and the immediate trigger never write the same issue twice in one window (F6)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    const driver = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    expect(driver.processed).toBe(1);
    expect(calls.mutation).toBe(1);

    // The trigger arrives right after the driver: it must NOT write again.
    const trigger = await t.action(internal.linearSync.runScheduledSync, triggerArgs());
    expect(trigger).toBeNull();
    expect(calls.mutation).toBe(1);
  });

  it("the trigger refuses to write while another driver holds the claim (F6)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true });

    // Simulate an attempt that is IN FLIGHT right now: the row carries the
    // `syncing` marker and a fresh timestamp.
    const row = await ledgerRow(t, association.associationId);
    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "syncing", updatedAt: Date.now() }));

    const trigger = await t.action(internal.linearSync.runScheduledSync, triggerArgs());
    expect(trigger).toBeNull();
    expect(calls.mutation).toBe(0);
    expect(calls.detail).toBe(0);
    const after = await ledgerRow(t, association.associationId);
    expect(after!.state).toBe("syncing");
    expect(after!.attemptCount).toBe(0);
  });

  it("a failed row is re-driven only after its backoff window elapsed (F8)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true, mutationStatus: 429 });

    const now = Date.now();
    const row = await ledgerRow(t, association.associationId);
    await t.run(async (ctx) => ctx.db.patch(row!._id, {
      state: "retryable", attemptCount: 1, lastErrorCode: "rate_limited", updatedAt: now,
    }));

    // Too early: the ladder holds the row back.
    const early = await t.action(internal.linearSync.driveRetryable, { now });
    expect(early.processed).toBe(0);
    expect(early.skipped.backoff).toBe(1);
    expect(calls.mutation).toBe(0);

    // The 429 ladder floor is one hour: ten minutes later the row is still
    // held back, so the driver does not sustain the rate limiting.
    const tenMinutesLater = await t.action(internal.linearSync.driveRetryable, { now: now + 10 * 60_000 });
    expect(tenMinutesLater.processed).toBe(0);
    expect(tenMinutesLater.skipped.backoff).toBe(1);

    // An hour later the row is driven again (the 429 floor is one hour, plus
    // up to half an hour of jitter).
    const later = await t.action(internal.linearSync.driveRetryable, { now: now + 120 * 60_000 });
    expect(later.processed).toBe(1);
    expect(calls.mutation).toBe(1);
  });

  it("the retry ladder is above the cron tick, ramps, and jitters (F8)", () => {
    const tickMs = CRON_TICK_MINUTES * 60_000;
    const first = retryBackoffMs(1);
    const second = retryBackoffMs(2);
    const third = retryBackoffMs(3);
    // Every rung is above the tick: the ramp can actually engage.
    expect(first).toBeGreaterThan(tickMs);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // ...and bounded above by the ladder's last rung plus its jitter.
    expect(retryBackoffMs(99)).toBeLessThanOrEqual(360 * 60_000 * 1.5);
    // Jitter: the delay is not a constant.
    const samples = new Set(Array.from({ length: 20 }, () => retryBackoffMs(3)));
    expect(samples.size).toBeGreaterThan(1);
    // A rate-limited row waits at least an hour.
    expect(retryBackoffMs(1, "rate_limited")).toBeGreaterThanOrEqual(60 * 60_000);
    // A row that never failed is not delayed at all.
    expect(retryBackoffMs(0)).toBe(0);
  });

  it("the driver is bounded by count and by time (F9)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    for (let i = 0; i < 5; i += 1) {
      await t.mutation(internal.linearAssociationStore.ensureAssociation, {
        ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
        linearIssueId: `issue-bulk-${i}`, linearIssueIdentifier: `EGA-${900 + i}`, t3ConnectionId: t3,
        t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(20 + i),
        attemptId: `attempt-bulk-${i}`, correlationKey: `[helm:issue-bulk-${i}:corr]`, at: Date.now(),
      });
    }
    const calls = installLinearStub({ moveOnWrite: true });

    // The count bound: two rows per run, never five.
    const bounded = await t.action(internal.linearSync.driveRetryable, { now: Date.now(), limit: 2 });
    expect(bounded.processed).toBe(2);
    expect(calls.mutation).toBe(2);

    // The time bound: a run with no time left does no work at all.
    const noTime = await t.action(internal.linearSync.driveRetryable, { now: Date.now(), timeBudgetMs: 0 });
    expect(noTime.processed).toBe(0);
  });

  it("the driver serves the least-recently-touched row first and rotates the queue (F9)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const oldest = await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: "issue-oldest", linearIssueIdentifier: "EGA-1", t3ConnectionId: t3,
      t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(30),
      attemptId: "attempt-oldest", correlationKey: "[helm:issue-oldest:corr]", at: Date.now() - 60_000,
    });
    const newest = await t.mutation(internal.linearAssociationStore.ensureAssociation, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearTeamId: "team-eng",
      linearIssueId: "issue-newest", linearIssueIdentifier: "EGA-2", t3ConnectionId: t3,
      t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ThreadId: testThreadId(31),
      attemptId: "attempt-newest", correlationKey: "[helm:issue-newest:corr]", at: Date.now(),
    });
    const calls = installLinearStub({ moveOnWrite: true });

    await t.action(internal.linearSync.driveRetryable, { now: Date.now(), limit: 1 });
    // The oldest row went first, so the newest one is still pending.
    const newestRow = await ledgerRow(t, newest.associationId);
    expect(newestRow!.state).toBe("pending");
    const oldestRow = await ledgerRow(t, oldest.associationId);
    expect(oldestRow!.state).toBe("synced");
    expect(calls.mutation).toBe(1);
  });

  it("a persistently failing row stops being retried at the bound (F10)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const association = await seedLaunchAssociation(t, t3);
    const calls = installLinearStub({ moveOnWrite: true, mutationStatus: 429 });

    const row = await ledgerRow(t, association.associationId);
    const before = row!.updatedAt;
    await t.run(async (ctx) => ctx.db.patch(row!._id, {
      state: "retryable", attemptCount: 100, lastErrorCode: "timed_out", updatedAt: 0,
    }));

    const result = await t.action(internal.linearSync.driveRetryable, { now: Date.now() });
    // The row is NOT processed, and it is skipped FOR THE BOUND REASON — not
    // because it happened to fail for some other reason.
    expect(result.processed).toBe(0);
    expect(result.skippedTotal).toBe(1);
    expect(result.skipped.bound).toBe(1);
    expect(result.skipped.backoff).toBe(0);
    expect(calls.mutation).toBe(0);
    // ...and the row is left exactly as it was.
    const after = await ledgerRow(t, association.associationId);
    expect(after!.attemptCount).toBe(100);
    expect(after!.updatedAt).toBe(0);
    expect(before).toBeDefined();
  });

  it("the driver reports WHY every row was left alone (F13)", async () => {
    const t = await granted();
    const t3 = await seedT3Connection(t);
    await seedMapping(t, t3);
    await seedLinearConnection(t);
    const launch = await seedLaunchAssociation(t, t3);
    const manual = await seedManualAssociation(t, t3);
    installLinearStub({ moveOnWrite: true });

    const now = Date.now();
    // The launch-derived row is held back by its BACKOFF window (it failed
    // once, one second ago); the manual row is held back because it is
    // MANUAL.
    const launchRow = await ledgerRow(t, launch.associationId);
    await t.run(async (ctx) => ctx.db.patch(launchRow!._id, {
      state: "retryable", attemptCount: 1, lastErrorCode: "timed_out", updatedAt: now - 1_000,
    }));

    const result = await t.action(internal.linearSync.driveRetryable, { now });
    // Every skip reason is reported, not collapsed into one counter.
    expect(Object.keys(result.skipped).sort()).toEqual([
      "alreadySynced", "backoff", "bound", "duplicate", "error", "inFlight", "manual", "noAssociation", "noGrant",
    ]);
    expect(result.skipped.backoff).toBe(1);
    expect(result.skipped.manual).toBe(1);
    expect(result.processed).toBe(0);
    // The breakdown accounts for every skipped row.
    expect(result.skippedTotal).toBe(
      result.skipped.bound + result.skipped.backoff + result.skipped.manual + result.skipped.noGrant +
      result.skipped.duplicate + result.skipped.inFlight + result.skipped.alreadySynced +
      result.skipped.noAssociation + result.skipped.error,
    );
    expect(result.skippedTotal).toBe(2);
    // The manual row is still untouched.
    const manualRow = await ledgerRow(t, manual.associationId);
    expect(manualRow!.state).toBe("pending");
    expect(manualRow!.attemptCount).toBe(0);
  });
});
