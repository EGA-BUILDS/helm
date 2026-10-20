import { describe, expect, it } from "vitest";
import {
  createSendAdapter,
  decodeSendResult,
  mintClientRequestId,
  toSendError,
} from "./send";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const acceptedWire = {
  outcome: "accepted",
  reason: null,
  detail: "T3 accepted the follow-up message.",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
  messageId: "msg-1",
  runId: "run:thread:ordinal:1",
  clientRequestId: "req-1",
  dedupe: "not_duplicate_observed",
};

const input = {
  connectionId: "conn-1",
  projectId: "t3-proj-1",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
  message: "follow up: confirm the plan",
  clientRequestId: "req-1",
};

describe("follow-up send adapter", () => {
  it("decodes an accepted result with the message identity", () => {
    expect(decodeSendResult(acceptedWire)).toEqual(acceptedWire);
  });

  it("requires a reason on rejected and ambiguous outcomes", () => {
    expect(() => decodeSendResult({ ...acceptedWire, outcome: "rejected", reason: null })).toThrow(/reason/i);
    expect(
      decodeSendResult({ ...acceptedWire, outcome: "ambiguous", reason: "ambiguous", messageId: null, detail: "unclear" })
        .reason,
    ).toBe("ambiguous");
  });

  it("rejects an unknown outcome instead of treating it as accepted", () => {
    expect(() => decodeSendResult({ ...acceptedWire, outcome: "sent" })).toThrow(/outcome/i);
  });

  it("rejects a missing duplicate state instead of assuming no duplicate", () => {
    const withoutState: Record<string, unknown> = { ...acceptedWire };
    delete withoutState.dedupe;
    expect(() => decodeSendResult(withoutState)).toThrow(/duplicate/i);
  });

  it("rejects an unknown duplicate state instead of reading it as no duplicate", () => {
    expect(() => decodeSendResult({ ...acceptedWire, dedupe: "deduplicated" })).toThrow(/duplicate/i);
    expect(() => decodeSendResult({ ...acceptedWire, dedupe: true })).toThrow(/duplicate/i);
  });

  it("accepts every observed duplicate state", () => {
    for (const dedupe of ["not_duplicate_observed", "duplicate_observed", "unverified"]) {
      expect(decodeSendResult({ ...acceptedWire, dedupe }).dedupe).toBe(dedupe);
    }
  });

  it("posts the reviewed follow-up verbatim to the send route", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const adapter = createSendAdapter(async (url, init) => {
      seen = { url, init };
      return response(200, acceptedWire);
    });
    const result = await adapter.send(input);
    expect(result.outcome).toBe("accepted");
    expect(seen!.url).toBe("/api/t3/threads/send");
    const sent = JSON.parse(String(seen!.init!.body));
    expect(sent).toEqual({
      connectionId: "conn-1",
      projectId: "t3-proj-1",
      threadId: "mcp:00000000-0000-4000-8000-000000000001",
      message: "follow up: confirm the plan",
      clientRequestId: "req-1",
    });
  });

  it("maps a rejected envelope to its actionable detail", async () => {
    const adapter = createSendAdapter(async () =>
      response(200, {
        ...acceptedWire,
        outcome: "rejected",
        reason: "not_found",
        detail: "That thread is no longer available; reselect it before sending.",
        messageId: null,
      }),
    );
    const result = await adapter.send(input);
    expect(result.reason).toBe("not_found");
    expect(result.detail).toMatch(/reselect/);
  });

  it("maps an invalid request to a non-retryable error", async () => {
    const adapter = createSendAdapter(async () =>
      response(400, { error: { code: "invalid_request", message: "The follow-up request is invalid.", retryable: false } }),
    );
    const error = await adapter.send(input).catch((thrown) => toSendError(thrown));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("mints request ids that satisfy the route validator", () => {
    for (let i = 0; i < 10; i += 1) {
      const id = mintClientRequestId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
    }
    expect(new Set([mintClientRequestId(), mintClientRequestId()]).size).toBe(2);
  });
});
