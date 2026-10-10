import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

// Per convex/_generated/ai/guidelines.md: build the module registry with
// import.meta.glob and drive functions through generated api references.
function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const modules = import.meta.glob("./**/*.ts");

/**
 * EGA-677 task 5 + M-2 + L-3: a lost launch acknowledgment must be
 * reconcilable by a UNIQUE key persisted BEFORE dispatch, an ambiguous match
 * must NEVER authorize a relaunch, reservation must be durably idempotent, and
 * state transitions must be monotonic.
 */

const at = 1_700_000_000_000;
const PAYLOAD_A = "a".repeat(64);
const PAYLOAD_B = "b".repeat(64);

describe("launchAttempts: durable reservation (M-2)", () => {
  it("persists a unique correlation key BEFORE dispatch", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "attempt-1",
      payloadHash: PAYLOAD_A,
    });
    expect(a.state).toBe("prepared");
    expect(a.correlationKey).toContain("EGA-681");
    expect(a.reused).toBe(false);

    const stored = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
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
      const a = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: `attempt-${i}`,
        payloadHash: PAYLOAD_A,
      });
      keys.add(a.correlationKey);
      // Settle each attempt so the one-unresolved-attempt guard does not block
      // the next: suffix uniqueness across SAME-ISSUE attempts is what is
      // under test here.
      await t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId: `attempt-${i}`,
        threadId: testThreadId(i + 1),
        at,
      });
    }
    // Uniqueness is the entire basis of safe reconciliation.
    expect(keys.size).toBe(25);
  });

  it("reuses the attempt when the SAME id returns with the SAME payload", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "req-1",
      payloadHash: PAYLOAD_A,
    });
    const retry = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "req-1",
      payloadHash: PAYLOAD_A,
    });
    expect(retry.reused).toBe(true);
    // Same correlation key: the retry keeps the identity the launch embedded.
    expect(retry.correlationKey).toBe(first.correlationKey);
    expect(retry.attemptId).toBe("req-1");
    const rows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(rows).toHaveLength(1);
  });

  it("rejects the SAME id presented with a DIFFERENT payload", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "req-1",
      payloadHash: PAYLOAD_A,
    });
    await expect(
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "req-1",
        payloadHash: PAYLOAD_B,
      }),
    ).rejects.toThrow(/different payload/);
    // The original reservation is untouched.
    const row = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "req-1",
    });
    expect(row?.state).toBe("prepared");
  });

  it("blocks a NEW request id while an earlier attempt for the issue is unresolved", async () => {
    for (const state of ["prepared", "dispatching", "ambiguous"] as const) {
      const t = convexTest(schema, modules);
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "req-1",
        payloadHash: PAYLOAD_A,
      });
      if (state === "dispatching") {
        await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "req-1", at });
      }
      if (state === "ambiguous") {
        await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "req-1", at });
        await t.mutation(internal.launchAttempts.recordReconciliation, {
          attemptId: "req-1",
          matchCount: 0,
          threadId: null,
        });
      }
      await expect(
        t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
          issueKey: "EGA-681",
          attemptId: "req-2",
          payloadHash: PAYLOAD_A,
        }),
      ).rejects.toThrow(/unresolved attempt/);
    }
  });

  it("finds an unresolved row beyond the former 100-row window", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 101; i++) {
      const id = `settled-${i}`;
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: id,
        payloadHash: PAYLOAD_A,
      });
      await t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId: id,
        threadId: testThreadId(i + 1000),
        at: at + i,
      });
    }
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "unresolved-after-101",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, {
      attemptId: "unresolved-after-101",
      at: at + 102,
    });

    await expect(
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "must-not-launch",
        payloadHash: PAYLOAD_A,
      }),
    ).rejects.toThrow(/unresolved attempt/);
  });

  it("allows a reservation after more than 100 settled attempts", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 105; i++) {
      const id = `settled-${i}`;
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: id,
        payloadHash: PAYLOAD_A,
      });
      await t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId: id,
        threadId: testThreadId(i + 1000),
        at: at + i,
      });
    }
    const next = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-681",
      attemptId: "settled-history-next",
      payloadHash: PAYLOAD_A,
    });
    expect(next.reused).toBe(false);
    expect(next.state).toBe("prepared");
  });

  it("serializes different request IDs competing for one issue", async () => {
    const t = convexTest(schema, modules);
    const results = await Promise.allSettled([
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "competing-a",
        payloadHash: PAYLOAD_A,
      }),
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "competing-b",
        payloadHash: PAYLOAD_A,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
    expect(rows).toHaveLength(1);
  });

  it("same request ID races reuse one durable reservation", async () => {
    const t = convexTest(schema, modules);
    const results = await Promise.all([
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "same-race",
        payloadHash: PAYLOAD_A,
      }),
      t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "same-race",
        payloadHash: PAYLOAD_A,
      }),
    ]);
    expect(results.map((r) => r.correlationKey)).toEqual([
      results[0]!.correlationKey,
      results[0]!.correlationKey,
    ]);
    expect(results.filter((r) => r.reused)).toHaveLength(1);
    expect(await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect())).toHaveLength(1);
  });

  it("allows a NEW request id after the earlier attempt settled or was abandoned", async () => {
    for (const closer of ["acknowledge", "abandon"] as const) {
      const t = convexTest(schema, modules);
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "req-1",
        payloadHash: PAYLOAD_A,
      });
      if (closer === "acknowledge") {
        await t.mutation(internal.launchAttempts.markAcknowledged, {
          attemptId: "req-1",
          threadId: testThreadId(1),
          at,
        });
      } else {
        await t.mutation(internal.launchAttempts.abandonAttempt, {
          attemptId: "req-1",
          note: "operator decided",
        });
      }
      const second = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-681",
        attemptId: "req-2",
        payloadHash: PAYLOAD_A,
      });
      expect(second.reused).toBe(false);
      // An explicit relaunch carries its own correlation key and history.
      expect(second.correlationKey).not.toBeNull();
    }
  });
});

describe("launchAttempts: monotonic transitions (L-3)", () => {
  it("reconciles to exactly one match and marks it safe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "lost-ack",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "lost-ack", at });
    const v = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "lost-ack",
      matchCount: 1,
      threadId: testThreadId(2),
    });
    expect(v.state).toBe("reconciled");
    expect(v.safeToProceed).toBe(true);
    expect(v.threadId).toBe(testThreadId(2));
    // Even on success, reconciliation never authorizes a relaunch.
    expect(v.relaunchAuthorized).toBe(false);
  });

  it("treats ZERO matches as ambiguous and forbids relaunch", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "zero",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "zero", at });
    const v = await t.mutation(internal.launchAttempts.recordReconciliation, {
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
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "many",
      payloadHash: PAYLOAD_A,
    });
    const v = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "many",
      matchCount: 3,
      threadId: null,
    });
    expect(v.state).toBe("ambiguous");
    expect(v.safeToProceed).toBe(false);
    expect(v.relaunchAuthorized).toBe(false);
    // An ambiguous verdict must not adopt one of the candidates as the answer.
    expect(v.threadId).toBe(null);
  });

  it.each(["", "has whitespace", "bad\nvalue", "x".repeat(129), "mcp:not-a-uuid", "mcp:" + "0".repeat(40)])(
    "rejects malformed acknowledgment thread identifiers (%s)",
    async (threadId) => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: "EGA-677",
        attemptId: "bad-thread-id",
        payloadHash: PAYLOAD_A,
      });
      await expect(t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId: "bad-thread-id",
        threadId,
        at,
      })).rejects.toThrow(/invalid thread identifier/);
    },
  );

  it("rejects contradictory or malformed reconciliation observations", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "bad-reconciliation",
      payloadHash: PAYLOAD_A,
    });
    await expect(t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "bad-reconciliation",
      matchCount: 1,
      threadId: null,
    })).rejects.toThrow(/disagree/);
    await expect(t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "bad-reconciliation",
      matchCount: 1,
      threadId: "bad\nthread",
    })).rejects.toThrow(/invalid thread identifier/);
    await expect(t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "bad-reconciliation",
      matchCount: 1,
      threadId: "alphabetic-only-secret",
    })).rejects.toThrow(/invalid thread identifier/);
  });

  it("NEVER regresses an acknowledged attempt to ambiguous (the L-3 defect)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "acked",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "acked", at });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "acked",
      threadId: testThreadId(3),
      at,
    });
    // A late reconciliation that sees nothing (stale search, listing lag,
    // contradiction) must not undo the acknowledgment.
    const v = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "acked",
      matchCount: 0,
      threadId: null,
    });
    expect(v.state).toBe("acknowledged");
    expect(v.threadId).toBe(testThreadId(3));
    expect(v.relaunchAuthorized).toBe(false);
    const row = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "acked",
    });
    expect(row?.state).toBe("acknowledged");
    expect(row?.threadId).toBe(testThreadId(3));
  });

  it("preserves a settled result against a CONFLICTING single-match observation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "conflict",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "conflict", at });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "conflict",
      threadId: testThreadId(4),
      at,
    });
    const v = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "conflict",
      matchCount: 1,
      threadId: testThreadId(5),
    });
    // The acknowledged thread identity wins; the conflict is recorded, not adopted.
    expect(v.state).toBe("acknowledged");
    expect(v.threadId).toBe(testThreadId(4));
  });

  it("repeated reconciliation of a reconciled attempt is idempotent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "twice",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "twice", at });
    const first = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "twice",
      matchCount: 1,
      threadId: testThreadId(6),
    });
    expect(first.state).toBe("reconciled");
    const second = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "twice",
      matchCount: 1,
      threadId: testThreadId(6),
    });
    expect(second.state).toBe("reconciled");
    expect(second.threadId).toBe(testThreadId(6));
    // An out-of-order later observation of nothing still changes nothing.
    const third = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "twice",
      matchCount: 0,
      threadId: null,
    });
    expect(third.state).toBe("reconciled");
    expect(third.threadId).toBe(testThreadId(6));
  });

  it("a LATE acknowledgment resolves an ambiguous attempt (out-of-order ack)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "late-ack",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "late-ack", at });
    // First: reconciliation sees nothing -> ambiguous.
    await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "late-ack",
      matchCount: 0,
      threadId: null,
    });
    // Then: the original launch's receipt finally arrives.
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "late-ack",
      threadId: testThreadId(7),
      at: at + 60_000,
    });
    const row = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "late-ack",
    });
    expect(row?.state).toBe("acknowledged");
    expect(row?.threadId).toBe(testThreadId(7));
  });

  it("refuses to re-acknowledge a settled attempt onto a DIFFERENT thread", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "two-threads",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "two-threads", at });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "two-threads",
      threadId: testThreadId(8),
      at,
    });
    // Same thread: idempotent no-op.
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "two-threads",
      threadId: testThreadId(8),
      at: at + 1,
    });
    // Different thread: a conflict, refused rather than absorbed.
    await expect(
      t.mutation(internal.launchAttempts.markAcknowledged, {
        attemptId: "two-threads",
        threadId: testThreadId(9),
        at: at + 2,
      }),
    ).rejects.toThrow(/refusing to re-acknowledge/);
  });

  it("never moves a settled attempt back into dispatching", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "settled",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "settled",
      threadId: testThreadId(1),
      at,
    });
    await expect(
      t.mutation(internal.launchAttempts.markDispatching, { attemptId: "settled", at: at + 5 }),
    ).rejects.toThrow(/already settled/);
  });

  it("an ambiguous attempt cannot re-enter dispatching without reconciliation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "ambiguous-then",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markDispatching, { attemptId: "ambiguous-then", at });
    await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "ambiguous-then",
      matchCount: 0,
      threadId: null,
    });
    await expect(
      t.mutation(internal.launchAttempts.markDispatching, { attemptId: "ambiguous-then", at: at + 5 }),
    ).rejects.toThrow(/cannot enter dispatching/);
  });

  it("surfaces ambiguous attempts for a human", async () => {
    const t = convexTest(schema, modules);
    for (const id of ["amb-a", "amb-b"]) {
      // Distinct issue keys: the one-unresolved-attempt guard would otherwise
      // (correctly) refuse the second reservation for the same issue.
      await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: `EGA-677-${id}`,
        attemptId: id,
        payloadHash: PAYLOAD_A,
      });
      await t.mutation(internal.launchAttempts.recordReconciliation, {
        attemptId: id,
        matchCount: 2,
        threadId: null,
      });
    }
    const queue = await t.query(internal.launchAttempts.listAmbiguousAttempts, {});
    expect(queue.map((q) => q.attemptId).sort()).toEqual(["amb-a", "amb-b"]);
    for (const q of queue) {
      const detail = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
        attemptId: q.attemptId,
      });
      expect(detail?.relaunchAuthorized).toBe(false);
    }
  });

  it("requires an explicit operator action to abandon, and never a settled one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "abandon-me",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.abandonAttempt, {
      attemptId: "abandon-me",
      note: "owner decision",
    });
    const row = await t.query(internal.launchAttempts.getCorrelationForReconciliation, {
      attemptId: "abandon-me",
    });
    expect(row?.state).toBe("abandoned");
    expect(await t.query(internal.launchAttempts.listAmbiguousAttempts, {})).toHaveLength(0);

    // A settled attempt cannot be abandoned: its evidence must survive.
    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677",
      attemptId: "keep-me",
      payloadHash: PAYLOAD_A,
    });
    await t.mutation(internal.launchAttempts.markAcknowledged, {
      attemptId: "keep-me",
      threadId: testThreadId(10),
      at,
    });
    await expect(
      t.mutation(internal.launchAttempts.abandonAttempt, { attemptId: "keep-me" }),
    ).rejects.toThrow(/already settled/);
  });
});
