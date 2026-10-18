import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  blockerForAmbiguousAttempt,
  blockerForUnresolvedAttempt,
  blockersForOutcome,
  canStartNewExecutionForOutcome,
  deriveOutcomeForAttempt,
  type AttemptRecoveryLatest,
} from "./lib/attemptRecovery";

const modules = import.meta.glob("./**/*.ts");
const PAYLOAD = "a".repeat(64);
const at = 1_700_000_000_000;

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function latest(state: string): AttemptRecoveryLatest {
  return {
    attemptId: "attempt-1",
    state,
    threadId: state === "acknowledged" || state === "reconciled" ? testThreadId(1) : null,
    correlationKey: "[helm:issue-1:recovery]",
    dispatchedAt: at,
    acknowledgedAt: state === "acknowledged" ? at + 1 : null,
    matchCount: null,
  };
}

describe("attemptRecovery: canStartNewExecution derivation across every state", () => {
  it("no history means a first execution may start", () => {
    expect(deriveOutcomeForAttempt(null)).toBe("none");
    expect(canStartNewExecutionForOutcome("none")).toBe(true);
    expect(blockersForOutcome("none", null)).toEqual([]);
  });

  it.each(["prepared", "dispatching"] as const)(
    "an unresolved attempt (%s) blocks a new execution with an actionable blocker",
    (state) => {
      expect(deriveOutcomeForAttempt(state)).toBe("unresolved");
      expect(canStartNewExecutionForOutcome("unresolved")).toBe(false);
      const row = latest(state);
      const blockers = blockersForOutcome("unresolved", row);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain("attempt-1");
      expect(blockers[0]).toContain(state);
      expect(blockers[0]).toBe(blockerForUnresolvedAttempt("attempt-1", state));
    },
  );

  it.each(["acknowledged", "reconciled"] as const)(
    "a settled attempt (%s) reports acknowledged and allows a new execution",
    (state) => {
      expect(deriveOutcomeForAttempt(state)).toBe("acknowledged");
      expect(canStartNewExecutionForOutcome("acknowledged")).toBe(true);
      expect(blockersForOutcome("acknowledged", latest(state))).toEqual([]);
    },
  );

  it("an ambiguous attempt blocks a new execution and never authorizes a relaunch", () => {
    expect(deriveOutcomeForAttempt("ambiguous")).toBe("ambiguous");
    expect(canStartNewExecutionForOutcome("ambiguous")).toBe(false);
    const blockers = blockersForOutcome("ambiguous", latest("ambiguous"));
    expect(blockers).toEqual([blockerForAmbiguousAttempt()]);
    expect(blockerForAmbiguousAttempt()).toMatch(/reconcile/i);
  });

  it("an abandoned attempt allows a new execution", () => {
    expect(deriveOutcomeForAttempt("abandoned")).toBe("abandoned");
    expect(canStartNewExecutionForOutcome("abandoned")).toBe(true);
    expect(blockersForOutcome("abandoned", latest("abandoned"))).toEqual([]);
  });

  it("an unknown state fails closed as unresolved", () => {
    expect(deriveOutcomeForAttempt("migrating")).toBe("unresolved");
    expect(canStartNewExecutionForOutcome(deriveOutcomeForAttempt("migrating"))).toBe(false);
  });
});

describe("attemptsForIssue: newest-first, per-issue reads", () => {
  async function seedIssueHistory(issueKey: string, states: string[]) {
    const t = convexTest(schema, modules);
    for (let i = 0; i < states.length; i++) {
      const attemptId = `${issueKey}-attempt-${i}`;
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey,
        issueIdentifier: "EGA-681",
        targetProjectId: "t3-proj-1",
        attemptId,
        payloadHash: PAYLOAD,
      });
      const state = states[i]!;
      if (state === "dispatching") {
        await t.mutation(internal.launchAttempts.markDispatching, { attemptId, at: at + i });
      }
      if (state === "acknowledged") {
        await t.mutation(internal.launchAttempts.markDispatching, { attemptId, at: at + i });
        await t.mutation(internal.launchAttempts.markAcknowledged, {
          attemptId,
          threadId: testThreadId(100 + i),
          at: at + i + 1,
        });
      }
      if (state === "ambiguous") {
        await t.mutation(internal.launchAttempts.markDispatching, { attemptId, at: at + i });
        await t.mutation(internal.launchAttempts.recordReconciliation, {
          attemptId,
          matchCount: 0,
          threadId: null,
        });
      }
      if (state === "abandoned") {
        await t.mutation(internal.launchAttempts.abandonAttempt, { attemptId, note: "operator" });
      }
    }
    return t;
  }

  it("returns the newest attempt first for one issue", async () => {
    const t = await seedIssueHistory("issue-1", ["acknowledged", "acknowledged"]);
    const rows = await t.query(internal.launchAttempts.attemptsForIssue, { issueKey: "issue-1" });
    expect(rows.map((row) => row.attemptId)).toEqual(["issue-1-attempt-1", "issue-1-attempt-0"]);
    expect(rows[0]!.state).toBe("acknowledged");
    expect(rows[0]!.threadId).toBe(testThreadId(101));
    expect(rows[0]!.correlationKey).toContain("issue-1");
  });

  it("keeps two issues independent", async () => {
    const t = await seedIssueHistory("issue-1", ["acknowledged"]);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "issue-2",
      issueIdentifier: "EGA-682",
      targetProjectId: "t3-proj-1",
      attemptId: "issue-2-attempt-0",
      payloadHash: PAYLOAD,
    });
    const first = await t.query(internal.launchAttempts.attemptsForIssue, { issueKey: "issue-1" });
    const second = await t.query(internal.launchAttempts.attemptsForIssue, { issueKey: "issue-2" });
    expect(first.map((row) => row.attemptId)).toEqual(["issue-1-attempt-0"]);
    expect(second.map((row) => row.attemptId)).toEqual(["issue-2-attempt-0"]);
    expect(second[0]!.state).toBe("prepared");
  });

  it("returns an empty list when the issue has no attempts", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.launchAttempts.attemptsForIssue, { issueKey: "issue-new" })).toEqual([]);
  });

  it("bounds the window", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 3; i++) {
      const attemptId = `bounded-${i}`;
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "issue-bounded",
        attemptId,
        payloadHash: PAYLOAD,
      });
      await t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId,
        threadId: testThreadId(200 + i),
        at: at + i,
      });
    }
    const rows = await t.query(internal.launchAttempts.attemptsForIssue, {
      issueKey: "issue-bounded",
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attemptId)).toEqual(["bounded-2", "bounded-1"]);
  });
});
