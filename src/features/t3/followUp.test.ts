import { describe, expect, it } from "vitest";
import {
  followUpIdentityKey,
  followUpRequestId,
  isAcknowledged,
  responseIsCurrent,
  resultMatchesIdentity,
} from "./followUp";
import type { SendResult } from "./send";

/**
 * The pure rules the follow-up control depends on (EGA-764 D10).
 *
 * They are tested here, in a node environment with no DOM, so the identity,
 * idempotency and staleness rules are pinned independently of React.
 */

const identity = {
  connectionId: "conn-1",
  projectId: "t3-proj-1",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
};

function result(overrides: Partial<SendResult> = {}): SendResult {
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

describe("follow-up identity", () => {
  it("keys a selection by the full connection/project/thread triple", () => {
    expect(followUpIdentityKey(identity)).toContain("t3-proj-1");
    expect(followUpIdentityKey(identity)).not.toBe(
      followUpIdentityKey({ ...identity, projectId: "t3-proj-2" }),
    );
    expect(followUpIdentityKey(identity)).not.toBe(
      followUpIdentityKey({ ...identity, threadId: "mcp:other" }),
    );
    expect(followUpIdentityKey(identity)).not.toBe(
      followUpIdentityKey({ ...identity, connectionId: "conn-2" }),
    );
  });

  it("accepts a result only for the thread it answers for", () => {
    expect(resultMatchesIdentity(result(), identity)).toBe(true);
    expect(resultMatchesIdentity(result({ threadId: "mcp:other" }), identity)).toBe(false);
  });

  it("drops a response that arrives after the selection changed", () => {
    const requestIdentity = followUpIdentityKey(identity);
    expect(responseIsCurrent(requestIdentity, followUpIdentityKey(identity))).toBe(true);
    expect(
      responseIsCurrent(requestIdentity, followUpIdentityKey({ ...identity, threadId: "mcp:other" })),
    ).toBe(false);
    expect(
      responseIsCurrent(requestIdentity, followUpIdentityKey({ ...identity, projectId: "t3-proj-2" })),
    ).toBe(false);
    expect(
      responseIsCurrent(requestIdentity, followUpIdentityKey({ ...identity, connectionId: "conn-2" })),
    ).toBe(false);
  });
});

describe("follow-up idempotency key", () => {
  it("keeps one key across retries of the same message", () => {
    const minted = followUpRequestId(null, "confirm the plan", () => "req-1");
    expect(minted).toBe("req-1");
    const retried = followUpRequestId(minted, "confirm the plan", () => "req-2");
    expect(retried).toBe("req-1");
  });

  it("mints a fresh key for an edited message", () => {
    const edited = followUpRequestId(null, "confirm the plan, then deploy", () => "req-2");
    expect(edited).toBe("req-2");
  });

  it("mints nothing for an empty message", () => {
    expect(followUpRequestId(null, "   ", () => "req-1")).toBe(null);
    expect(followUpRequestId("req-1", "  ", () => "req-2")).toBe(null);
  });
});

describe("follow-up acknowledgement", () => {
  it("treats only accepted and queued as an acknowledgement", () => {
    expect(isAcknowledged("accepted")).toBe(true);
    expect(isAcknowledged("queued")).toBe(true);
    expect(isAcknowledged("rejected")).toBe(false);
    expect(isAcknowledged("ambiguous")).toBe(false);
  });
});
