import { describe, expect, it } from "vitest";
import {
  ACTIVITY_POLL_INTERVAL_MS,
  ACTIVITY_POLL_MAX_INTERVAL_MS,
  POLL_RETRY_AFTER_MAX_MS,
  SUMMARY_POLL_INTERVAL_MS,
  SUMMARY_POLL_MAX_INTERVAL_MS,
  activityPollDelay,
  activityPollPauseReason,
  boundedRetryAfterMs,
  summaryPollDelay,
  type ActivityPollInput,
} from "./polling";

const ready: ActivityPollInput = {
  enabled: true,
  documentVisible: true,
  connected: true,
  threadStatus: "running",
  detailReady: true,
  hasMore: false,
  nextPosition: 7,
};

describe("selected-thread poll eligibility", () => {
  it("allows exactly one visible, connected, running, caught-up thread", () => {
    expect(activityPollPauseReason(ready)).toBeNull();
  });

  it.each([
    ["disabled", { enabled: false }],
    ["hidden", { documentVisible: false }],
    ["disconnected", { connected: false }],
    ["unknown", { threadStatus: "idle" }],
    ["inactive", { threadStatus: "completed" }],
    ["inactive", { threadStatus: "waiting_for_approval" }],
    ["unknown", { threadStatus: null }],
    ["unknown", { threadStatus: "  " }],
    ["unknown", { threadStatus: "active" }],
    ["not-loaded", { detailReady: false }],
    ["more-activity", { hasMore: true }],
    ["no-cursor", { nextPosition: null }],
  ] as const)("pauses for %s", (reason, override) => {
    expect(activityPollPauseReason({ ...ready, ...override })).toBe(reason);
  });

  it("does not treat a quiet or unclassified status as a run", () => {
    expect(activityPollPauseReason({ ...ready, threadStatus: "archived" })).toBe("unknown");
    expect(activityPollPauseReason({ ...ready, threadStatus: "pending_cleanup" })).toBe("unknown");
  });
});

describe("bounded activity backoff", () => {
  it("uses the conservative base cadence with no failures", () => {
    expect(activityPollDelay(0)).toBe(ACTIVITY_POLL_INTERVAL_MS);
  });

  it("doubles after each failure and caps at the maximum", () => {
    expect(activityPollDelay(1)).toBe(ACTIVITY_POLL_INTERVAL_MS * 2);
    expect(activityPollDelay(2)).toBe(ACTIVITY_POLL_INTERVAL_MS * 4);
    expect(activityPollDelay(3)).toBe(ACTIVITY_POLL_MAX_INTERVAL_MS);
    expect(activityPollDelay(50)).toBe(ACTIVITY_POLL_MAX_INTERVAL_MS);
  });

  it("honours a valid Retry-After only when it extends the backoff", () => {
    expect(activityPollDelay(1, 5_000)).toBe(ACTIVITY_POLL_INTERVAL_MS * 2);
    expect(activityPollDelay(1, 60_000)).toBe(60_000);
    expect(activityPollDelay(3, 1)).toBe(ACTIVITY_POLL_MAX_INTERVAL_MS);
    expect(activityPollDelay(3, POLL_RETRY_AFTER_MAX_MS * 2)).toBe(POLL_RETRY_AFTER_MAX_MS);
    expect(boundedRetryAfterMs(Number.NaN)).toBeNull();
    expect(boundedRetryAfterMs(-1)).toBeNull();
    expect(boundedRetryAfterMs(0)).toBeNull();
  });

  it("uses a separate, slower summary cadence", () => {
    expect(summaryPollDelay(0)).toBe(SUMMARY_POLL_INTERVAL_MS);
    expect(summaryPollDelay(1)).toBe(SUMMARY_POLL_INTERVAL_MS * 2);
    expect(summaryPollDelay(9)).toBe(SUMMARY_POLL_MAX_INTERVAL_MS);
    expect(summaryPollDelay(1, 4_000)).toBe(SUMMARY_POLL_INTERVAL_MS * 2);
    expect(summaryPollDelay(1, 240_000)).toBe(240_000);
  });
});
