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
