import { describe, expect, it } from "vitest";
import {
  createInterruptAdapter,
  decodeAttentionResult,
  decodeInterruptResult,
  toInterruptError,
} from "./interrupt";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const requestedWire = {
  outcome: "requested",
  reason: null,
  detail: "Interrupt requested. T3 reported interrupt_requested: the request was accepted, not verified as terminated.",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
  runId: "run:thread:ordinal:1",
  observedAt: "2026-10-19T00:00:00.000Z",
  t3Reference: "Open T3 thread mcp:00000000-0000-4000-8000-000000000001 in project t3-proj-1 to review and act.",
};

const input = {
  connectionId: "c-1",
  projectId: "t3-proj-1",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
  runId: "run:thread:ordinal:1",
};

describe("native interrupt adapter", () => {
  it("decodes a requested result with the T3 handoff reference", () => {
    expect(decodeInterruptResult(requestedWire)).toEqual(requestedWire);
  });

  it("requires a reason on every outcome except requested", () => {
    expect(() =>
      decodeInterruptResult({ ...requestedWire, outcome: "rejected", reason: null }),
    ).toThrow(/reason/i);
    expect(() =>
      decodeInterruptResult({ ...requestedWire, reason: "ambiguous" }),
    ).toThrow(/reason/i);
    expect(
      decodeInterruptResult({
        ...requestedWire,
        outcome: "already_terminal",
        reason: "already_terminal",
        runId: "run:thread:ordinal:1",
      }).reason,
    ).toBe("already_terminal");
  });

  it("decodes a post-dispatch ambiguous result that says the interrupt was sent", () => {
    const decoded = decodeInterruptResult({
      ...requestedWire,
      outcome: "ambiguous",
      reason: "dispatch_outcome_unknown",
      detail: "The interrupt call was sent, but its acknowledgement was not received.",
    });
    // The envelope must distinguish "sent, unknown whether applied" from
    // "never sent": sent-unverified carries its own reason.
    expect(decoded.outcome).toBe("ambiguous");
    expect(decoded.reason).toBe("dispatch_outcome_unknown");
    expect(decoded.detail).toMatch(/was sent/iu);
    expect(decoded.detail).not.toMatch(/no interruption was issued/iu);
  });

  it("keeps the sent/not-sent ambiguity distinction intact", () => {
    // Pre-dispatch ambiguity (state unverifiable BEFORE any call) stays
    // reason `ambiguous`; only the post-dispatch envelope carries
    // `dispatch_outcome_unknown`.
    expect(decodeInterruptResult({ ...requestedWire, outcome: "ambiguous", reason: "ambiguous" }).reason).toBe(
      "ambiguous",
    );
    expect(() =>
      decodeInterruptResult({ ...requestedWire, outcome: "ambiguous", reason: "interrupt_pending" }),
    ).toThrow(/reason/i);
  });

  it("decodes an in-flight interrupt receipt as already requested, not settled", () => {
    const decoded = decodeInterruptResult({
      ...requestedWire,
      outcome: "already_terminal",
      reason: "inflight_interrupt",
      detail: "An interrupt request is already in flight for that run and has NOT settled.",
    });
    expect(decoded.outcome).toBe("already_terminal");
    expect(decoded.reason).toBe("inflight_interrupt");
    expect(decoded.detail).toMatch(/NOT settled/);
    expect(decoded.detail).not.toMatch(/terminated/iu);
  });

  it("rejects an unknown outcome instead of treating it as requested", () => {
    expect(() => decodeInterruptResult({ ...requestedWire, outcome: "sent" })).toThrow(/outcome/i);
  });

  it("rejects an envelope without a T3 reference", () => {
    const withoutReference: Record<string, unknown> = { ...requestedWire };
    delete withoutReference.t3Reference;
    expect(() => decodeInterruptResult(withoutReference)).toThrow(/reference/i);
  });

  it("posts the interrupt identity verbatim to the interrupt route", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const adapter = createInterruptAdapter(async (url, init) => {
      seen = { url, init };
      return response(200, requestedWire);
    });
    const result = await adapter.interrupt(input);
    expect(result.outcome).toBe("requested");
    expect(seen!.url).toBe("/api/t3/threads/interrupt");
    const sent = JSON.parse(String(seen!.init!.body));
    expect(sent).toMatchObject({
      connectionId: "c-1",
      projectId: "t3-proj-1",
      threadId: "mcp:00000000-0000-4000-8000-000000000001",
      runId: "run:thread:ordinal:1",
    });
  });

  it("maps a rejected envelope to its actionable detail", async () => {
    const adapter = createInterruptAdapter(async () =>
      response(200, {
        ...requestedWire,
        outcome: "rejected",
        reason: "invalid_run",
        detail: "That run is not a run of this thread; no interruption was issued.",
      }),
    );
    const result = await adapter.interrupt(input);
    expect(result.reason).toBe("invalid_run");
    expect(result.detail).toMatch(/not a run of this thread/);
  });

  it("maps an invalid request to a non-retryable error", async () => {
    const adapter = createInterruptAdapter(async () =>
      response(400, { error: { code: "invalid_request", message: "The interrupt request is invalid.", retryable: false } }),
    );
    const error = await adapter.interrupt(input).catch((thrown) => toInterruptError(thrown));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("decodes attention states and requires a handoff reference", () => {
    const wire = {
      state: "needs_attention",
      basis: "An active run is waiting.",
      observedAt: "2026-10-19T00:00:00.000Z",
      t3Reference: "Open T3 thread t in project p to review and act.",
    };
    expect(decodeAttentionResult(wire)).toEqual(wire);
    expect(() => decodeAttentionResult({ ...wire, state: "waiting" })).toThrow(/state/i);
  });

  it("fetches attention over GET with the thread identity", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const wire = {
      state: "running",
      basis: "An active run is making progress.",
      observedAt: "2026-10-19T00:00:00.000Z",
      t3Reference: "Open T3 thread t in project p to review and act.",
    };
    const adapter = createInterruptAdapter(async (url, init) => {
      seen = { url, init };
      return response(200, wire);
    });
    const result = await adapter.attention({
      connectionId: "c-1",
      projectId: "t3-proj-1",
      threadId: "mcp:00000000-0000-4000-8000-000000000001",
    });
    expect(result.state).toBe("running");
    expect(seen!.url).toContain("/api/t3/threads/attention?");
    expect(seen!.url).toContain("threadId=");
    expect(seen!.init!.method).toBe("GET");
  });
});
