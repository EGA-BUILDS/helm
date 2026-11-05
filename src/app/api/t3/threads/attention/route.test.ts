import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("../../../../../lib/t3Backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/t3Backend")>();
  return {
    ...actual,
    ownerConvexClient: async () => ({ action: mocks.action }),
  };
});

import { GET } from "./route";
import { ATTENTION_REQUEST_INVALID } from "../../../../../../convex/lib/attentionErrors";
import { MAX_T3_THREAD_ID_READ_LENGTH } from "../../../../../../convex/lib/threadIdentity";

const ORIGIN = "https://helm.example";
const DELEGATED =
  "thread:delegated-task:command%3Amcp%3A6a3438e6-1f36-46fc-9940-4966e6d273df%3Adelegate-task%3A3676395b-913d-4bb5-887e-9fb3089e4bb2";

function attentionUrl(threadId: string): string {
  const query = new URLSearchParams({
    connectionId: "conn1",
    projectId: "t3-proj-1",
    threadId,
  });
  return `${ORIGIN}/api/t3/threads/attention?${query.toString()}`;
}

function request(threadId: string): Request {
  return new Request(attentionUrl(threadId), { headers: { referer: `${ORIGIN}/dashboard` } });
}

const ok = {
  state: "idle",
  basis: "Every observed run reached a terminal state; nothing is waiting.",
  observedAt: "2026-11-04T00:00:00.000Z",
  t3Reference: `Open T3 thread ${DELEGATED} in project t3-proj-1 to review and act.`,
};

describe("GET /api/t3/threads/attention — native thread identity round trip", () => {
  beforeEach(() => {
    process.env.HELM_APP_URL = ORIGIN;
    mocks.action.mockResolvedValue(ok);
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
    mocks.action.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards a delegated-task id with its literal %3A segments unchanged", async () => {
    // The browser adapter builds `URLSearchParams`, so `%` becomes `%25` on the
    // wire and `searchParams.get` decodes exactly once. The route must hand the
    // original literal id to the Convex action: no decodeURIComponent anywhere.
    expect(DELEGATED.length).toBeGreaterThan(128);
    expect(attentionUrl(DELEGATED)).toContain("%253A");

    const response = await GET(request(DELEGATED));
    expect(response.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(expect.anything(), {
      connectionId: "conn1",
      projectId: "t3-proj-1",
      threadId: DELEGATED,
    });
    const body = await response.json();
    expect(body).toMatchObject({ state: "idle" });
  });

  it("accepts the read-side bound and refuses anything longer", async () => {
    const prefix = "thread:provider:codex:native-thread:";
    const atBound = `${prefix}${"a".repeat(MAX_T3_THREAD_ID_READ_LENGTH - prefix.length)}`;
    expect(atBound.length).toBe(MAX_T3_THREAD_ID_READ_LENGTH);
    expect((await GET(request(atBound))).status).toBe(200);

    mocks.action.mockClear();
    const over = `${atBound}a`;
    const response = await GET(request(over));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe(ATTENTION_REQUEST_INVALID);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("maps an unsupported identifier to a clear 400, never an opaque upstream failure", async () => {
    mocks.action.mockRejectedValue(new Error(ATTENTION_REQUEST_INVALID));
    const response = await GET(request("thread:whatever"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "invalid_request", message: ATTENTION_REQUEST_INVALID });
  });
});
