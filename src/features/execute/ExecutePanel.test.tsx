import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecuteReviewView,
  SUBAGENT_NOTE,
  type ExecuteReviewViewProps,
} from "./ExecutePanel";
import { buildFinalPayload } from "./prompt";
import { decodePreflight, type PreflightVerdict } from "./preflight";
import type { LinearIssueDetail } from "../linear/issues";

const issue: LinearIssueDetail = {
  id: "issue-1",
  identifier: "EGA-761",
  title: "Editable execution prompt",
  url: "https://linear.app/helm/issue/EGA-761",
  priority: 2,
  priorityLabel: "High",
  state: { id: "s-1", name: "In Progress", type: "started" },
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  assignee: null,
  description: "Ship the review surface.",
  acceptanceCriteria: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

function verdictWire(overrides: Record<string, unknown> = {}) {
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
      providers: [
        {
          providerInstanceId: "openai",
          displayName: "OpenAI",
          models: [{ id: "gpt-5", label: "GPT-5" }],
        },
      ],
      runtimeMode: "supervised",
      freshness: { source: "backend", observedAt: "2026-10-18T00:00:00.000Z", stale: false },
    },
    catalogError: null,
    blockers: [],
    ...overrides,
  };
}

function viewProps(overrides: Partial<ExecuteReviewViewProps> = {}): ExecuteReviewViewProps {
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
    confirmed: false,
    onReview: () => {},
    onConfirm: () => {},
    launchDisabled: true,
    launchDisabledReason: "Confirm the review above first.",
    launching: false,
    launchResult: null,
    launchError: null,
    onLaunch: () => {},
    ...overrides,
  };
}

describe("execution review view", () => {
  it("shows the exact final payload verbatim", () => {
    const props = viewProps();
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, props));
    expect(html).toContain("do the thing");
    expect(html).toContain("gpt-5");
    // The payload text parses back to byte-identical fields.
    const parsed = JSON.parse(props.payloadText!);
    expect(parsed).toEqual(props.payload);
    expect(parsed.prompt).toBe(props.review.prompt);
  });

  it("defaults subagents to No and carries the not-enforced note", () => {
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, viewProps()));
    expect(html).toContain(SUBAGENT_NOTE);
    expect(SUBAGENT_NOTE).toMatch(/not enforced by Helm/);
    expect(html).toContain("No");
  });

  it("rejects Yes-subagents without a model and disables Execute", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          review: {
            prompt: "do the thing",
            providerInstanceId: "openai",
            model: "gpt-5",
            useSubagents: true,
            subagentModel: null,
          },
          selectionError: "Choose a preferred subagent model or switch subagents off.",
          payload: null,
          payloadText: null,
          executeDisabled: true,
        }),
      ),
    );
    expect(html).toContain("preferred subagent model");
    expect(html).toContain("disabled");
  });

  it("shows the destination, permission mode, and catalog freshness", () => {
    const props = viewProps();
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, props));
    expect(html).toContain("refs/heads/main");
    expect(html).toContain("Helm native");
    expect(html).toContain("supervised");
    expect(html).toContain("1 providers");
    expect(html).toContain("2026-10-18T00:00:00.000Z");
  });

  it("disables Execute and lists actionable blockers", () => {
    const blocked = decodePreflight(
      verdictWire({ catalog: null, blockers: ["Linear authorization was revoked; reconnect to continue."] }),
    );
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          verdict: blocked,
          payload: null,
          payloadText: null,
          executeDisabled: true,
        }),
      ),
    );
    expect(html).toContain("Execute is disabled");
    expect(html).toContain("revoked");
    expect(html).toContain("disabled");
  });

  it("refuses a model absent from the live catalog", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          review: {
            prompt: "do the thing",
            providerInstanceId: "openai",
            model: "gpt-9",
            useSubagents: false,
            subagentModel: null,
          },
          selectionError: "That model is not in the live T3 catalog; pick an advertised one.",
          payload: null,
          payloadText: null,
          executeDisabled: true,
        }),
      ),
    );
    expect(html).toContain("live T3 catalog");
  });

  it("decodes the preflight verdict with catalog and blockers", () => {
    const decoded: PreflightVerdict = decodePreflight(verdictWire());
    expect(decoded.t3ProjectTitle).toBe("Helm native");
    expect(decoded.worktreeBaseRef).toBe("refs/heads/main");
    expect(decoded.targetBranch).toBe("main");
    expect(decoded.catalog?.providers).toHaveLength(1);
    expect(decoded.blockers).toEqual([]);
  });

  it("disables the explicit launch step until the review is confirmed", () => {
    const html = renderToStaticMarkup(createElement(ExecuteReviewView, viewProps()));
    expect(html).toContain("Launch thread");
    expect(html).toContain("Confirm the review above first.");
    // Reviewing never launches: no thread id is shown before an explicit click.
    expect(html).not.toContain("Thread mcp:");
  });

  it("enables the launch step once confirmed and shows the exact payload", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({ confirmed: true, launchDisabled: false, launchDisabledReason: null }),
      ),
    );
    expect(html).toContain("Launch thread");
    expect(html).toContain("Launches exactly the payload shown above");
    expect(html).not.toContain("Confirm the review above first.");
  });

  it("explains why a subagent review cannot launch natively", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          confirmed: true,
          launchDisabled: true,
          launchDisabledReason:
            "Switch subagents off to launch; the native launch cannot forward a subagent preference yet.",
        }),
      ),
    );
    expect(html).toContain("Switch subagents off to launch");
  });

  it("renders the launched thread identity from the launch result", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          confirmed: true,
          launchDisabled: true,
          launchDisabledReason: "Already launched — a new execution needs a fresh review.",
          launchResult: {
            outcome: "launched",
            reason: null,
            detail: "T3 launch acknowledged.",
            attemptId: "attempt-1",
            correlationKey: "[helm:proj-1]",
            threadId: "mcp:00000000-0000-4000-8000-000000000001",
          },
        }),
      ),
    );
    expect(html).toContain("T3 launch acknowledged.");
    expect(html).toContain("mcp:00000000-0000-4000-8000-000000000001");
  });

  it("renders an ambiguous launch without claiming a thread", () => {
    const html = renderToStaticMarkup(
      createElement(
        ExecuteReviewView,
        viewProps({
          confirmed: true,
          launchDisabled: false,
          launchDisabledReason: null,
          launchResult: {
            outcome: "ambiguous",
            reason: "ambiguous",
            detail: "The launch acknowledgement was unclear; reconciliation found 0 matching threads. No relaunch was authorized.",
            attemptId: "attempt-1",
            correlationKey: "[helm:proj-1]",
            threadId: null,
          },
        }),
      ),
    );
    expect(html).toContain("ambiguous");
    expect(html).toContain("No relaunch was authorized.");
    expect(html).not.toContain("Thread mcp:");
  });
});
