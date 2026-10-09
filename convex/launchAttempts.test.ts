import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

// Per convex/_generated/ai/guidelines.md: build the module registry with
// import.meta.glob and drive functions through generated api references.
const modules = import.meta.glob("./**/*.ts");

/**
 * EGA-677 task 5: a lost launch acknowledgment must be reconcilable by a UNIQUE
 * key persisted BEFORE dispatch, and an ambiguous match must NEVER authorize a
 * relaunch.
 *
 * These tests encode the exact failure the proof produced: T3 accepted a launch,
 * the receipt was lost, and the only thing that saved us from a duplicate was
 * being able to search for a unique marker.
 */
describe("launchAttempts", () => {
  const at = 1_700_000_000_000;

  it("persists a unique correlation key BEFORE dispatch", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "attempt-1",
    });
    expect(a.state).toBe("prepared");
    expect(a.correlationKey).toContain("EGA-681");

    const stored = await t.query(api.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "attempt-1",
    });
    // The key exists before any dispatch happened.
    expect(stored?.correlationKey).toBe(a.correlationKey);
    expect(stored?.state).toBe("prepared");
  });

  it("gives every attempt a distinct correlation key", async () => {
    const t = convexTest(schema, modules);
    const keys = new Set<string>();
    for (let i = 1; i <= 25; i++) {
      const a = await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: `attempt-${i}`,
      });
      keys.add(a.correlationKey);
    }
    // Uniqueness is the entire basis of safe reconciliation.
    expect(keys.size).toBe(25);
  });

  it("refuses a duplicate attemptId rather than corrupting correlation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "dup",
    });
    await expect(
      t.mutation(api.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "dup",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("reconciles to exactly one match and marks it safe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "lost-ack",
    });
    await t.mutation(api.launchAttempts.markDispatching, { attemptId: "lost-ack", at });
    // Ack was lost. Reconciliation finds the one thread that was really created.
    const v = await t.mutation(api.launchAttempts.recordReconciliation, {
      attemptId: "lost-ack",
      matchCount: 1,
      threadId: "mcp:abc",
    });
    expect(v.state).toBe("reconciled");
    expect(v.safeToProceed).toBe(true);
    expect(v.threadId).toBe("mcp:abc");
    // Even on success, reconciliation never authorizes a relaunch.
    expect(v.relaunchAuthorized).toBe(false);
  });

  it("treats ZERO matches as ambiguous and forbids relaunch", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "zero",
    });
    await t.mutation(api.launchAttempts.markDispatching, { attemptId: "zero", at });
    const v = await t.mutation(api.launchAttempts.recordReconciliation, {
      attemptId: "zero",
      matchCount: 0,
      threadId: null,
    });
    // Zero matches could mean the launch never landed, or that it landed and we
    // cannot see it. Only a human can decide; it must never auto-retry.
    expect(v.state).toBe("ambiguous");
    expect(v.safeToProceed).toBe(false);
    expect(v.relaunchAuthorized).toBe(false);
  });

  it("treats MANY matches as ambiguous and forbids relaunch", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "many",
    });
    const v = await t.mutation(api.launchAttempts.recordReconciliation, {
      attemptId: "many",
      matchCount: 3,
      threadId: "mcp:maybe",
    });
    expect(v.state).toBe("ambiguous");
    expect(v.safeToProceed).toBe(false);
    expect(v.relaunchAuthorized).toBe(false);
    // An ambiguous verdict must not adopt one of the candidates as the answer.
    expect(v.threadId).toBe(null);
  });

  it("surfaces ambiguous attempts for a human", async () => {
    const t = convexTest(schema, modules);
    for (const id of ["amb-a", "amb-b"]) {
      await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-677",
        attemptId: id,
      });
      await t.mutation(api.launchAttempts.recordReconciliation, {
        attemptId: id,
        matchCount: 2,
        threadId: null,
      });
    }
    const queue = await t.query(api.launchAttempts.listAmbiguousAttempts, {});
    expect(queue.map((q) => q.attemptId).sort()).toEqual(["amb-a", "amb-b"]);
    for (const q of queue) {
      const detail = await t.query(api.launchAttempts.getCorrelationForReconciliation, {
        attemptId: q.attemptId,
      });
      expect(detail?.relaunchAuthorized).toBe(false);
    }
  });

  it("never moves a settled attempt back into dispatching", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "settled",
    });
    await t.mutation(api.launchAttempts.markAcknowledged, {
      attemptId: "settled",
      threadId: "mcp:one",
      at,
    });
    // A late duplicate dispatch must not reopen a settled attempt.
    await expect(
      t.mutation(api.launchAttempts.markDispatching, { attemptId: "settled", at: at + 5 }),
    ).rejects.toThrow(/already settled/);
  });

  it("requires an explicit operator action to abandon", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "abandon-me",
    });
    await t.mutation(api.launchAttempts.abandonAttempt, {
      attemptId: "abandon-me",
      note: "owner decision",
    });
    const row = await t.query(api.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "abandon-me",
    });
    expect(row?.state).toBe("abandoned");
    expect((await t.query(api.launchAttempts.listAmbiguousAttempts, {}))).toHaveLength(0);
  });
});