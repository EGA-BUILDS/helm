import { describe, expect, it } from "vitest";
import {
  createLaunchAdapter,
  decodeLaunchResult,
  toLaunchError,
} from "./launch";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const launchedWire = {
  outcome: "launched",
  reason: null,
  detail: "T3 launch acknowledged.",
  attemptId: "attempt-1",
  correlationKey: "[helm:proj-1]",
  threadId: "mcp:00000000-0000-4000-8000-000000000001",
};

const input = {
  attemptId: "attempt-1",
  linearProjectId: "proj-1",
  linearTeamId: "team-eng",
  linearIssueId: "issue-1",
  linearIssueIdentifier: "EGA-681",
  prompt: "do the thing",
  providerInstanceId: "openai",
  model: "gpt-5",
  runtimeMode: "supervised",
  useSubagents: false,
  subagentModel: null,
};

describe("native launch adapter", () => {
  it("decodes a launched result with the thread identity", () => {
    expect(decodeLaunchResult(launchedWire)).toEqual(launchedWire);
  });

  it("requires a reason on blocked and ambiguous outcomes", () => {
    expect(() =>
      decodeLaunchResult({ ...launchedWire, outcome: "blocked", reason: null }),
    ).toThrow(/reason/i);
    expect(
      decodeLaunchResult({
        ...launchedWire,
        outcome: "ambiguous",
        reason: "ambiguous",
        threadId: null,
        detail: "The launch acknowledgement was unclear; reconciliation found 0 matching threads. No relaunch was authorized.",
      }).reason,
    ).toBe("ambiguous");
  });

  it("rejects an unknown outcome instead of treating it as launched", () => {
    expect(() => decodeLaunchResult({ ...launchedWire, outcome: "sent" })).toThrow(/outcome/i);
  });

  it("posts the reviewed payload verbatim to the launch route", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const adapter = createLaunchAdapter(async (url, init) => {
      seen = { url, init };
      return response(200, launchedWire);
    });
    const result = await adapter.launch(input);
    expect(result.outcome).toBe("launched");
    expect(seen!.url).toBe("/api/t3/launch");
    const sent = JSON.parse(String(seen!.init!.body));
    expect(sent.prompt).toBe("do the thing");
    expect(sent.model).toBe("gpt-5");
    expect(sent.attemptId).toBe("attempt-1");
    // The real Linear issue identity travels end to end, never a project/team key.
    expect(sent.linearIssueId).toBe("issue-1");
    expect(sent.linearIssueIdentifier).toBe("EGA-681");
  });

  it("maps a blocked envelope to its actionable detail", async () => {
    const adapter = createLaunchAdapter(async () =>
      response(200, {
        ...launchedWire,
        outcome: "blocked",
        reason: "model_unavailable",
        detail: "That model is not in the live T3 catalog; pick an advertised one.",
        threadId: null,
      }),
    );
    const result = await adapter.launch(input);
    expect(result.reason).toBe("model_unavailable");
    expect(result.detail).toMatch(/live T3 catalog/);
  });

  it("maps an invalid request to a non-retryable error", async () => {
    const adapter = createLaunchAdapter(async () =>
      response(400, { error: { code: "invalid_request", message: "The launch request is invalid.", retryable: false } }),
    );
    const error = await adapter.launch(input).catch((thrown) => toLaunchError(thrown));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
  });
});
