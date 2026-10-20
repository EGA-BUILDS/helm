import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InterruptAttentionLine,
  InterruptControl,
  InterruptResultView,
  interruptStatusCopy,
  confirmationTargetChanged,
  resolveConfirmClick,
  type ConfirmationTarget,
  type InterruptControlProps,
} from "./InterruptControl";
import type { InterruptResult } from "./interrupt";

function props(overrides: Partial<InterruptControlProps> = {}): InterruptControlProps {
  return {
    connectionId: "c-1",
    projectId: "t3-proj-1",
    threadId: "mcp:00000000-0000-4000-8000-000000000001",
    runId: "run:thread:ordinal:1",
    ...overrides,
  };
}

function target(overrides: Partial<ConfirmationTarget> = {}): ConfirmationTarget {
  return {
    connectionId: "c-1",
    projectId: "t3-proj-1",
    threadId: "mcp:00000000-0000-4000-8000-000000000001",
    runId: "run:thread:ordinal:1",
    runStatus: "starting",
    ...overrides,
  };
}

function resultWire(overrides: Partial<InterruptResult> = {}): InterruptResult {
  return {
    outcome: "requested",
    reason: null,
    detail: "Interrupt requested.",
    threadId: "mcp:00000000-0000-4000-8000-000000000001",
    runId: "run:thread:ordinal:1",
    observedAt: "2026-10-19T00:00:00.000Z",
    t3Reference: "Open T3 thread t in project p to review and act.",
    ...overrides,
  };
}

describe("InterruptControl", () => {
  it("renders a single Interrupt button before confirmation, never the confirm text", () => {
    const html = renderToStaticMarkup(createElement(InterruptControl, props()));
    expect(html).toContain("Interrupt");
    expect(html).not.toContain("Confirm interrupt");
    expect(html).not.toContain("Requesting interrupt");
  });

  it("describes the honest states without ever claiming verified termination", () => {
    const requested = interruptStatusCopy("requested");
    expect(requested.heading).toBe("Interrupt requested");
    expect(requested.note).toMatch(/not verified as terminated/);
    expect(interruptStatusCopy("already_terminal").note).toMatch(/No second interrupt/);
    expect(interruptStatusCopy("no_active_run").note).toMatch(/nothing was deleted/);
    expect(interruptStatusCopy("rejected").note).toMatch(/before any interrupt call/);
    expect(interruptStatusCopy("ambiguous").note).toMatch(/No retry/);
  });

  it("renders the attention line with its basis and T3 reference", () => {
    const html = renderToStaticMarkup(
      createElement(InterruptAttentionLine, {
        attention: {
          state: "needs_attention",
          basis: "An active run is waiting.",
          observedAt: "2026-10-19T00:00:00.000Z",
          t3Reference: "Open T3 thread t in project p to review and act.",
        },
      }),
    );
    expect(html).toContain("needs attention");
    expect(html).toContain("An active run is waiting.");
    expect(html).toContain("Open T3 thread t");
  });

  it("renders nothing for the attention line without attention", () => {
    expect(renderToStaticMarkup(createElement(InterruptAttentionLine, { attention: null }))).toBe("");
  });

  it("the requested result wire decodes through the honest copy", () => {
    const wire = resultWire();
    expect(wire.reason).toBe(null);
    expect(interruptStatusCopy(wire.outcome).heading).toBe("Interrupt requested");
  });

  it("a stale armed confirmation is discarded when the selection changes", () => {
    const armed = target();
    // Any identity field change — connection, project, thread, run, or the
    // last-observed run status — invalidates the confirmation.
    expect(confirmationTargetChanged(armed, target({ connectionId: "c-2" }))).toBe(true);
    expect(confirmationTargetChanged(armed, target({ projectId: "t3-proj-2" }))).toBe(true);
    expect(confirmationTargetChanged(armed, target({ threadId: "mcp:00000000-0000-4000-8000-000000000002" }))).toBe(
      true,
    );
    expect(confirmationTargetChanged(armed, target({ runId: "run:thread:ordinal:2" }))).toBe(true);
    expect(confirmationTargetChanged(armed, target({ runStatus: "interrupt_requested" }))).toBe(true);
    // Same selection still confirms.
    expect(confirmationTargetChanged(armed, target())).toBe(false);
  });

  it("a stale confirmation cannot fire against the new selection", () => {
    // Armed against run 1; the owner switched run 2 into the selection. The
    // click decision must discard — it never constructs an interrupt input
    // for the previous run.
    expect(resolveConfirmClick(target({ runId: "run:thread:ordinal:1" }), target({ runId: "run:thread:ordinal:2" })))
      .toEqual({ action: "discard" });
    // Same for a run-status refresh between arm and confirm.
    expect(resolveConfirmClick(target({ runStatus: "starting" }), target({ runStatus: "running" }))).toEqual({
      action: "discard",
    });
    // And for a thread switch.
    expect(
      resolveConfirmClick(
        target({ threadId: "mcp:00000000-0000-4000-8000-000000000001", runId: "run:thread:ordinal:1" }),
        target({ threadId: "mcp:00000000-0000-4000-8000-000000000002", runId: "run:thread:ordinal:1" }),
      ),
    ).toEqual({ action: "discard" });
  });

  it("a current confirmation dispatches with the confirmed identity", () => {
    const step = resolveConfirmClick(target(), target(), "req-1");
    expect(step).toEqual({
      action: "submit",
      input: {
        connectionId: "c-1",
        projectId: "t3-proj-1",
        threadId: "mcp:00000000-0000-4000-8000-000000000001",
        runId: "run:thread:ordinal:1",
        clientRequestId: "req-1",
      },
    });
    // Unarmed clicks discard too.
    expect(resolveConfirmClick(null, target())).toEqual({ action: "discard" });
  });

  it("interrupt_requested is rendered as requested, never as confirmed termination", () => {
    const html = renderToStaticMarkup(createElement(InterruptResultView, { result: resultWire() }));
    expect(html).toContain("Interrupt requested");
    // Requested is described as accepted-not-verified, explicitly telling the
    // owner it does NOT mean the run has terminated.
    expect(html).toMatch(/does not mean the run has terminated/iu);
    expect(html).toMatch(/re-read the thread to confirm/iu);
    expect(html).not.toMatch(/verified termination|successfully interrupted|now terminal|has been stopped/iu);
  });

  it("an in-flight interrupt receipt is rendered as requested, not settled", () => {
    const copy = interruptStatusCopy("already_terminal", "inflight_interrupt");
    expect(copy.heading).toBe("Interrupt already requested");
    expect(copy.note).toMatch(/not verified as terminated/);
    expect(copy.note).toMatch(/No second interrupt/);
    const html = renderToStaticMarkup(
      createElement(InterruptResultView, {
        result: resultWire({
          outcome: "already_terminal",
          reason: "inflight_interrupt",
          detail: "An interrupt request is already in flight for that run and has NOT settled.",
        }),
      }),
    );
    expect(html).toContain("Interrupt already requested");
    expect(html).toMatch(/has NOT settled/iu);
    expect(html).not.toMatch(/is terminal|terminated|has been stopped|was stopped/iu);
  });

  it("a post-dispatch unclear result says the interrupt was sent, with no retry", () => {
    const copy = interruptStatusCopy("ambiguous", "dispatch_outcome_unknown");
    expect(copy.heading).toBe("Unclear result");
    expect(copy.note).toMatch(/was sent/iu);
    expect(copy.note).toMatch(/No retry/iu);
    const html = renderToStaticMarkup(
      createElement(InterruptResultView, {
        result: resultWire({
          outcome: "ambiguous",
          reason: "dispatch_outcome_unknown",
          detail: "The interrupt call was sent, but Helm cannot confirm whether the interrupt was applied.",
        }),
      }),
    );
    expect(html).toContain("Unclear result");
    expect(html).toMatch(/was sent/iu);
  });

  it("a pre-dispatch unclear result never claims the interrupt was sent", () => {
    const copy = interruptStatusCopy("ambiguous", "ambiguous");
    expect(copy.note).not.toMatch(/was sent/iu);
  });
});
