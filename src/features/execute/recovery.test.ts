import { describe, expect, it } from "vitest";
import {
  canStartNewExecutionForOutcome,
  chooseAttemptIdForLaunch,
  decodeAttemptRecovery,
  deriveOutcomeForAttempt,
  recoveryLaunchGate,
  type AttemptRecovery,
} from "./recovery";
import { createLaunchAdapter, toLaunchError } from "./launch";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recoveryWire(overrides: Record<string, unknown> = {}) {
  return {
    latest: {
      attemptId: "attempt-1",
      state: "acknowledged",
      threadId: "mcp:00000000-0000-4000-8000-000000000001",
      correlationKey: "[helm:issue-1:recovery]",
      dispatchedAt: 1700000000000,
      acknowledgedAt: 1700000000001,
      matchCount: null,
    },
    outcome: "acknowledged",
    canStartNewExecution: true,
    blockers: [],
    ...overrides,
  };
}

const recoverInput = { linearProjectId: "proj-1", linearTeamId: "team-eng", linearIssueId: "issue-1" };

describe("attempt recovery adapter", () => {
  it("decodes an acknowledged recovery with the existing thread", () => {
    expect(decodeAttemptRecovery(recoveryWire())).toEqual(recoveryWire());
  });

  it("decodes a first-run recovery with no history", () => {
    expect(
      decodeAttemptRecovery({ latest: null, outcome: "none", canStartNewExecution: true, blockers: [] }),
    ).toEqual({ latest: null, outcome: "none", canStartNewExecution: true, blockers: [] });
  });

  it("rejects an unknown outcome instead of treating it as settled", () => {
    expect(() => decodeAttemptRecovery({ ...recoveryWire(), outcome: "sent" })).toThrow(/outcome/i);
  });

  it("rejects a non-boolean permission instead of guessing", () => {
    expect(() => decodeAttemptRecovery({ ...recoveryWire(), canStartNewExecution: "yes" })).toThrow(
      /permission/i,
    );
  });

  it("rejects non-string blockers", () => {
    expect(() => decodeAttemptRecovery({ ...recoveryWire(), blockers: [42] })).toThrow(/blocker/i);
  });

  it("rejects a malformed latest attempt", () => {
    expect(() =>
      decodeAttemptRecovery({ ...recoveryWire(), latest: { attemptId: "attempt-1" } }),
    ).toThrow(/recovery attempt/);
  });

  it("fetches the recovery over same-origin GET with bounded query params", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const adapter = createLaunchAdapter(async (url, init) => {
      seen = { url, init };
      return response(200, recoveryWire());
    });
    const recovery = await adapter.recover(recoverInput);
    expect(recovery.outcome).toBe("acknowledged");
    expect(seen!.init!.method).toBe("GET");
    const url = new URL(seen!.url, "https://helm.example");
    expect(url.pathname).toBe("/api/t3/launch");
    expect(url.searchParams.get("linearProjectId")).toBe("proj-1");
    expect(url.searchParams.get("linearTeamId")).toBe("team-eng");
    expect(url.searchParams.get("linearIssueId")).toBe("issue-1");
  });

  it("maps a denied recovery to a non-retryable error", async () => {
    const adapter = createLaunchAdapter(async () =>
      response(401, { error: { code: "access_denied", message: "Sign in.", retryable: false } }),
    );
    const error = await adapter.recover(recoverInput).catch((thrown) => toLaunchError(thrown));
    expect(error).toMatchObject({ code: "access_denied", retryable: false });
  });
});

describe("recovery derivation stays identical to the server rule", () => {
  it("derives every outcome exactly as the server does", () => {
    expect(deriveOutcomeForAttempt(null)).toBe("none");
    expect(deriveOutcomeForAttempt("prepared")).toBe("unresolved");
    expect(deriveOutcomeForAttempt("dispatching")).toBe("unresolved");
    expect(deriveOutcomeForAttempt("acknowledged")).toBe("acknowledged");
    expect(deriveOutcomeForAttempt("reconciled")).toBe("acknowledged");
    expect(deriveOutcomeForAttempt("ambiguous")).toBe("ambiguous");
    expect(deriveOutcomeForAttempt("abandoned")).toBe("abandoned");
    expect(canStartNewExecutionForOutcome("none")).toBe(true);
    expect(canStartNewExecutionForOutcome("unresolved")).toBe(false);
    expect(canStartNewExecutionForOutcome("acknowledged")).toBe(true);
    expect(canStartNewExecutionForOutcome("ambiguous")).toBe(false);
    expect(canStartNewExecutionForOutcome("abandoned")).toBe(true);
  });
});

describe("recovery launch gating", () => {
  function recovery(outcome: AttemptRecovery["outcome"], threadId: string | null = null): AttemptRecovery {
    return {
      latest:
        outcome === "none"
          ? null
          : {
              attemptId: "attempt-1",
              state: outcome === "acknowledged" ? "acknowledged" : outcome,
              threadId,
              correlationKey: "[helm:issue-1:recovery]",
              dispatchedAt: 1700000000000,
              acknowledgedAt: null,
              matchCount: null,
            },
      outcome,
      canStartNewExecution: canStartNewExecutionForOutcome(outcome),
      blockers: outcome === "unresolved" ? ["This issue already has an unresolved launch attempt."] : [],
    };
  }

  it("imposes no restriction on a first run or an abandoned attempt", () => {
    expect(recoveryLaunchGate(recovery("none"), { newExecutionArmed: false })).toBe(null);
    expect(recoveryLaunchGate(recovery("abandoned"), { newExecutionArmed: false })).toBe(null);
  });

  it("disables launch on an unresolved attempt with the actionable blocker", () => {
    const gate = recoveryLaunchGate(recovery("unresolved"), { newExecutionArmed: false });
    expect(gate?.disabled).toBe(true);
    expect(gate?.reason).toMatch(/unresolved launch attempt/);
  });

  it("disables launch on an ambiguous attempt and offers no relaunch", () => {
    const gate = recoveryLaunchGate(
      { ...recovery("ambiguous"), blockers: ["This launch ended ambiguous; reconcile it before launching again."] },
      { newExecutionArmed: false },
    );
    expect(gate?.disabled).toBe(true);
    expect(gate?.reason).toMatch(/ambiguous/);
  });

  it("disables the plain launch on an acknowledged attempt until a new execution is armed", () => {
    const gate = recoveryLaunchGate(recovery("acknowledged", "mcp:thread-1"), { newExecutionArmed: false });
    expect(gate?.disabled).toBe(true);
    expect(gate?.reason).toContain("mcp:thread-1");
    expect(gate?.reason).toMatch(/new execution/);
  });

  it("lifts the restriction once a new execution is separately confirmed", () => {
    expect(recoveryLaunchGate(recovery("acknowledged", "mcp:thread-1"), { newExecutionArmed: true })).toBe(null);
  });
});

describe("attempt identity selection", () => {
  const mint = () => "fresh-id";

  it("an explicit retry adopts the server's attemptId, never a new one", () => {
    const server: AttemptRecovery = {
      latest: {
        attemptId: "attempt-server",
        state: "dispatching",
        threadId: null,
        correlationKey: "[helm:issue-1:recovery]",
        dispatchedAt: 1700000000000,
        acknowledgedAt: null,
        matchCount: null,
      },
      outcome: "unresolved",
      canStartNewExecution: false,
      blockers: ["This issue already has an unresolved launch attempt."],
    };
    expect(chooseAttemptIdForLaunch({ recovery: server, retryStoredAttempt: true, mint })).toBe(
      "attempt-server",
    );
  });

  it("a new execution mints fresh even when browser storage held the old id", () => {
    const settled: AttemptRecovery = {
      latest: {
        attemptId: "attempt-old",
        state: "acknowledged",
        threadId: "mcp:thread-1",
        correlationKey: "[helm:issue-1:recovery]",
        dispatchedAt: 1700000000000,
        acknowledgedAt: 1700000000001,
        matchCount: null,
      },
      outcome: "acknowledged",
      canStartNewExecution: true,
      blockers: [],
    };
    // The local record is not consulted: correctness when it is empty (a
    // hard reload) is the whole point, so it is never consulted at all.
    expect(chooseAttemptIdForLaunch({ recovery: settled, retryStoredAttempt: false, mint })).toBe(
      "fresh-id",
    );
    expect(
      chooseAttemptIdForLaunch({ recovery: null, retryStoredAttempt: false, mint }),
    ).toBe("fresh-id");
  });
});
