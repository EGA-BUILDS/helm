import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FollowUpView, followUpDedupeCopy, followUpStatusCopy, type FollowUpViewProps } from "./FollowUpControl";
import type { SendResult } from "./send";

const identity = {
  connectionId: "conn-1",
  projectId: "t3-proj-1",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
};

function viewProps(overrides: Partial<FollowUpViewProps> = {}): FollowUpViewProps {
  return {
    ...identity,
    message: "",
    phase: "idle",
    result: null,
    error: null,
    onMessageChange: () => undefined,
    onSend: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
}

function acceptedResult(overrides: Partial<SendResult> = {}): SendResult {
  return {
    outcome: "accepted",
    reason: null,
    detail: "T3 accepted the follow-up message.",
    threadId: identity.threadId,
    messageId: "msg-1",
    runId: "run:thread:ordinal:1",
    clientRequestId: "req-1",
    dedupe: "not_duplicate_observed",
    ...overrides,
  };
}

describe("follow-up control", () => {
  it("always shows the exact thread identity", () => {
    const html = renderToStaticMarkup(createElement(FollowUpView, viewProps()));
    expect(html).toContain(identity.connectionId);
    expect(html).toContain(identity.projectId);
    expect(html).toContain(identity.threadId);
  });

  it("disables sending while a send is in flight", () => {
    const html = renderToStaticMarkup(createElement(FollowUpView, viewProps({ phase: "sending", message: "hello" })));
    expect(html).toContain("Sending…");
    expect(html).toContain("disabled");
  });

  it("never describes an accepted message as executed or complete", () => {
    const html = renderToStaticMarkup(
      createElement(FollowUpView, viewProps({ phase: "done", result: acceptedResult() })),
    );
    expect(html).toContain("T3 accepted the follow-up message.");
    expect(html).not.toMatch(/execut|complet|finished|done\./i);
  });

  it("reports a queued message as not yet run", () => {
    const html = renderToStaticMarkup(
      createElement(
        FollowUpView,
        viewProps({
          phase: "done",
          result: acceptedResult({
            outcome: "queued",
            messageId: null,
            detail: "T3 queued the follow-up message; it has not run yet.",
          }),
        }),
      ),
    );
    expect(html).toContain("has not run yet");
  });

  it("offers a same-request-id retry after an ambiguous outcome", () => {
    const html = renderToStaticMarkup(
      createElement(
        FollowUpView,
        viewProps({
          phase: "done",
          result: acceptedResult({ outcome: "ambiguous", reason: "ambiguous", messageId: null, detail: "unclear" }),
        }),
      ),
    );
    expect(html).toContain("Retry with the same request id");
  });

  it("renders transport errors without raw upstream text", () => {
    const html = renderToStaticMarkup(
      createElement(
        FollowUpView,
        viewProps({ phase: "done", error: { code: "unknown", message: "The follow-up message could not be sent.", retryable: false } }),
      ),
    );
    expect(html).toContain("The follow-up message could not be sent.");
  });

  it("states the duplicate observation exactly as it was observed", () => {
    // One native activity entry was observed for this request id.
    expect(followUpDedupeCopy("not_duplicate_observed")).toMatch(/exactly one native activity entry/);
    expect(followUpDedupeCopy("not_duplicate_observed")).not.toMatch(/second message|duplicate/i);
    // The thread already held this request id's activity.
    expect(followUpDedupeCopy("duplicate_observed")).toMatch(/no second message/i);
    // An inconclusive observation is stated as inconclusive.
    expect(followUpDedupeCopy("unverified")).toMatch(/could not verify/i);
    expect(followUpDedupeCopy("unverified")).not.toMatch(/no duplicate|exactly one/i);
  });

  it("never claims a duplicate that was not observed", () => {
    const unverified = followUpStatusCopy(acceptedResult({ dedupe: "unverified" }));
    expect(unverified).toMatch(/could not verify/i);
    expect(unverified).not.toMatch(/no second message|already held/i);
    const observed = followUpStatusCopy(acceptedResult({ dedupe: "duplicate_observed" }));
    expect(observed).toMatch(/no second message/i);
  });

  it("does not add a duplicate sentence to a refusal or an ambiguous outcome", () => {
    const rejected = followUpStatusCopy(
      acceptedResult({ outcome: "rejected", reason: "rejected", messageId: null, detail: "T3 refused the follow-up message; nothing was queued." }),
    );
    expect(rejected).toBe("T3 refused the follow-up message; nothing was queued.");
    expect(rejected).not.toMatch(/could not verify/i);
  });
});
