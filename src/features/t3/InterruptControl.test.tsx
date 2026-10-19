import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InterruptAttentionLine,
  InterruptControl,
  interruptStatusCopy,
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
});
