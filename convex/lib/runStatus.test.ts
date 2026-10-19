import { describe, expect, it } from "vitest";
import { classifyRunStatus, isLiveRun } from "./runStatus";

describe("classifyRunStatus", () => {
  it("classifies terminal runs from the observed probe vocabulary", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "canceled",
      "interrupted",
      "succeeded",
      "done",
      "aborted",
      "expired",
      "terminated",
      "settled",
    ]) {
      expect(classifyRunStatus(status), status).toBe("terminal");
    }
  });

  it("matches terminal states case-insensitively", () => {
    expect(classifyRunStatus("Interrupted")).toBe("terminal");
    expect(classifyRunStatus("COMPLETED")).toBe("terminal");
  });

  it("classifies an in-flight interrupt distinctly from terminal", () => {
    for (const status of ["interrupt_requested", "interrupting", "cancelling", "cancel_requested"]) {
      expect(classifyRunStatus(status), status).toBe("inflight_interrupt");
    }
  });

  it("classifies waiting runs that need owner action", () => {
    for (const status of [
      "awaiting_input",
      "waiting_for_approval",
      "pending",
      "paused",
      "blocked",
      "needs_input",
      "action_required",
      "approval-required",
    ]) {
      expect(classifyRunStatus(status), status).toBe("waiting");
    }
  });

  it("treats live-but-unremarkable runs as active, never terminal", () => {
    for (const status of ["starting", "running", "queued", "preparing", "in_progress"]) {
      expect(classifyRunStatus(status), status).toBe("active");
    }
  });

  it("treats missing or empty status as unknown, never terminal and never live", () => {
    for (const status of [null, undefined, "", "   ", 42, {}]) {
      expect(classifyRunStatus(status)).toBe("unknown");
      expect(isLiveRun(status)).toBe(false);
    }
  });

  it("marks active and waiting runs as live, terminal ones as not", () => {
    expect(isLiveRun("starting")).toBe(true);
    expect(isLiveRun("awaiting_input")).toBe(true);
    expect(isLiveRun("interrupted")).toBe(false);
    expect(isLiveRun("interrupt_requested")).toBe(false);
  });
});
