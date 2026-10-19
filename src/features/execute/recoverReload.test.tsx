import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecuteReviewView,
  describeLaunchDisabledReason,
  type ExecuteReviewViewProps,
} from "./ExecutePanel";
import { buildFinalPayload } from "./prompt";
import { clearAllAttemptRecords } from "./prompt";
import { decodePreflight } from "./preflight";
import type { LinearIssueDetail } from "../linear/issues";
import type { AttemptRecovery } from "./recovery";

/**
 * Hard-reload simulation (defects A and B).
 *
 * Every case starts by emptying the module-level browser records — exactly
 * what a full browser reload does to `attemptRecords` — and then builds the
 * component state fresh from a SERVER recovery projection. The UI must show
 * the recorded attempt accurately and must never offer a plain new launch
 * while the server reports anything but a startable state.
 */

const issue: LinearIssueDetail = {
  id: "issue-1",
  identifier: "EGA-681",
  title: "Native launch recovery",
  url: "https://linear.app/helm/issue/EGA-681",
  priority: 2,
  priorityLabel: "High",
  state: { id: "s-1", name: "In Progress", type: "started" },
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  assignee: null,
  description: "Ship the launch.",
  acceptanceCriteria: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

function verdictWire() {
  return {
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    t3ConnectionId: "c-1",
    t3EnvironmentId: "env-1",
    t3ProjectId: "t3-proj-1",
    t3ProjectTitle: "Helm native",
    worktreeBaseRef: "refs/heads/main",
    targetBranch: "main",
    startedStateId: "state-started",
    catalog: {
      providers: [{ providerInstanceId: "openai", displayName: "OpenAI", models: [{ id: "gpt-5", label: "GPT-5" }] }],
      runtimeMode: "supervised",
      freshness: { source: "backend", observedAt: "2026-10-18T00:00:00.000Z", stale: false },
    },
    catalogError: null,
    blockers: [],
  };
}

function recovered(state: string, threadId: string | null): AttemptRecovery {
  const outcome =
    state === "acknowledged" || state === "reconciled"
      ? "acknowledged"
      : state === "ambiguous"
        ? "ambiguous"
        : state === "abandoned"
          ? "abandoned"
          : "unresolved";
  return {
    latest: {
      attemptId: "attempt-server",
      state,
      threadId,
      correlationKey: "[helm:issue-1:recovery]",
      dispatchedAt: 1700000000000,
      acknowledgedAt: threadId ? 1700000000001 : null,
      matchCount: null,
    },
    outcome,
    canStartNewExecution: outcome === "acknowledged" || outcome === "abandoned",
    blockers:
      outcome === "unresolved"
        ? [`This issue already has an unresolved launch attempt (attempt-server, state ${state}); reconcile or abandon it before launching again.`]
        : outcome === "ambiguous"
          ? ["This launch ended ambiguous; reconcile it before launching again."]
          : [],
    observedLatestAttemptId: "attempt-server",
  };
}

function viewProps(recovery: AttemptRecovery | null, armed = false): ExecuteReviewViewProps {
  const verdict = decodePreflight(verdictWire());
  const review = {
    prompt: "do the thing",
    providerInstanceId: "openai",
    model: "gpt-5",
    useSubagents: false as const,
    subagentModel: null,
  };
  const payload = buildFinalPayload({
    ...review,
    worktreeBaseRef: "refs/heads/main",
    targetBranch: "main",
    runtimeMode: "supervised",
  });
  const reason = describeLaunchDisabledReason({
    confirmed: true,
    launching: false,
    recoveryLoading: false,
    recoveryError: null,
    verdictBlockers: verdict.blockers,
    selectionError: null,
    hasPayload: true,
    useSubagents: false,
    recovery,
    newExecutionArmed: armed,
    launchOutcome: null,
  });
  return {
    issue,
    verdict,
    preflightError: null,
    preflightLoading: false,
    review,
    selectionError: null,
    payload,
    payloadText: JSON.stringify(payload, null, 2),
    executeDisabled: false,
    confirmed: true,
    onReview: () => {},
    onConfirm: () => {},
    launchDisabled: reason !== null,
    launchDisabledReason: reason,
    launching: false,
    launchResult: null,
    launchError: null,
    onLaunch: () => {},
    attemptRecovery: recovery,
    recoveryLoading: false,
    recoveryError: null,
    onRefreshRecovery: () => {},
    newExecutionArmed: armed,
    onStartNewExecution: () => {},
    onCancelNewExecution: () => {},
    onRetryStoredAttempt: () => {},
    retryDisabled: recovery?.outcome !== "unresolved",
  };
}

describe("hard reload with a settled attempt", () => {
  it("shows the existing thread and does not offer a plain new launch", () => {
    clearAllAttemptRecords();
    const html = renderToStaticMarkup(
      createElement(ExecuteReviewView, viewProps(recovered("acknowledged", "mcp:thread-1"))),
    );
    expect(html).toContain("Already launched");
    expect(html).toContain("mcp:thread-1");
    // The plain launch control is disabled with a reason pointing at the
    // separately confirmed new execution …
    expect(html).toContain("start a new execution below");
    expect(html).toContain("disabled");
    // … and the explicit new-execution affordance is present.
    expect(html).toContain("Start a new execution");
  });

  it("arming a new execution lifts the plain-launch restriction", () => {
    clearAllAttemptRecords();
    const html = renderToStaticMarkup(
      createElement(ExecuteReviewView, viewProps(recovered("acknowledged", "mcp:thread-1"), true)),
    );
    expect(html).toContain("Confirm new execution");
    expect(html).not.toContain("start a new execution below");
  });

  it("a new execution is allowed only when the server says it may start", () => {
    expect(recovered("acknowledged", "mcp:thread-1").canStartNewExecution).toBe(true);
    expect(recovered("abandoned", null).canStartNewExecution).toBe(true);
    expect(recovered("dispatching", null).canStartNewExecution).toBe(false);
    expect(recovered("ambiguous", null).canStartNewExecution).toBe(false);
  });
});

describe("hard reload with an unresolved or ambiguous attempt", () => {
  it.each(["prepared", "dispatching"] as const)(
    "reload while %s: shows the state accurately, disables launch, performs no relaunch",
    (state) => {
      clearAllAttemptRecords();
      const recovery = recovered(state, null);
      const reason = describeLaunchDisabledReason({
        confirmed: true,
        launching: false,
        recoveryLoading: false,
        recoveryError: null,
        verdictBlockers: [],
        selectionError: null,
        hasPayload: true,
        useSubagents: false,
        recovery,
        newExecutionArmed: false,
        launchOutcome: null,
      });
      expect(reason).toContain("unresolved launch attempt");
      expect(reason).toContain("attempt-server");
      const html = renderToStaticMarkup(createElement(ExecuteReviewView, viewProps(recovery)));
      expect(html).toContain(`Prior attempt ${state}`);
      expect(html).toContain("nothing was relaunched");
      expect(html).toContain("Retry attempt attempt-server");
      // No second launch control is enabled: the only launch button is
      // disabled and the retry adopts the server id (asserted in
      // recovery.test.ts via chooseAttemptIdForLaunch).
      expect(html).toContain("disabled");
    },
  );

  it("reload after lost acknowledgement: ambiguous disables launch with no relaunch affordance", () => {
    clearAllAttemptRecords();
    const recovery = recovered("ambiguous", null);
    const reason = describeLaunchDisabledReason({
      confirmed: true,
      launching: false,
      recoveryLoading: false,
      recoveryError: null,
      verdictBlockers: [],
      selectionError: null,
      hasPayload: true,
      useSubagents: false,
      recovery,
      newExecutionArmed: false,
      launchOutcome: null,
    });
    expect(reason).toMatch(/ambiguous/);
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, viewProps(recovery)));
    expect(html).toContain("Prior attempt ambiguous");
    expect(html).toContain("no relaunch was issued");
    expect(html).not.toContain("Retry attempt");
  });
});

describe("hard reload with no history", () => {
  it("offers the normal launch once the review is confirmed", () => {
    clearAllAttemptRecords();
    const none: AttemptRecovery = { latest: null, outcome: "none", canStartNewExecution: true, blockers: [], observedLatestAttemptId: null };
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, viewProps(none)));
    expect(html).toContain("No prior executions for this issue.");
    expect(html).not.toContain("Confirm the review above first.");
  });
});

describe("launch gating fails closed while the server state is unknown", () => {
  it("disables launch while the recovery is loading or failed", () => {
    const loading = describeLaunchDisabledReason({
      confirmed: true,
      launching: false,
      recoveryLoading: true,
      recoveryError: null,
      verdictBlockers: [],
      selectionError: null,
      hasPayload: true,
      useSubagents: false,
      recovery: null,
      newExecutionArmed: false,
      launchOutcome: null,
    });
    expect(loading).toMatch(/Checking prior executions/);
    const failed = describeLaunchDisabledReason({
      confirmed: true,
      launching: false,
      recoveryLoading: false,
      recoveryError: "backend_unavailable",
      verdictBlockers: [],
      selectionError: null,
      hasPayload: true,
      useSubagents: false,
      recovery: null,
      newExecutionArmed: false,
      launchOutcome: null,
    });
    expect(failed).toMatch(/could not be verified/);
  });

  it("a recovered-but-unarmed acknowledged attempt keeps the legacy launched guard consistent", () => {
    const reason = describeLaunchDisabledReason({
      confirmed: true,
      launching: false,
      recoveryLoading: false,
      recoveryError: null,
      verdictBlockers: [],
      selectionError: null,
      hasPayload: true,
      useSubagents: false,
      recovery: recovered("acknowledged", "mcp:thread-1"),
      newExecutionArmed: false,
      launchOutcome: "launched",
    });
    // The recovery reason wins: it names the thread, the legacy guard does not.
    expect(reason).toContain("mcp:thread-1");
  });
});
