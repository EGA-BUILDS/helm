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
import { MAX_T3_THREAD_ID_READ_LENGTH } from "../../../../../../convex/lib/threadIdentity";

const ORIGIN = "https://helm.example";
const DELEGATED =
  "thread:delegated-task:command%3Amcp%3A6a3438e6-1f36-46fc-9940-4966e6d273df%3Adelegate-task%3A3676395b-913d-4bb5-887e-9fb3089e4bb2";

function request(threadId: string): Request {
  const query = new URLSearchParams({
    connectionId: "conn1",
    projectId: "t3-proj-1",
    threadId,
  });
  return new Request(`${ORIGIN}/api/t3/threads/pull-request?${query.toString()}`, {
    headers: { referer: `${ORIGIN}/dashboard` },
  });
}

describe("GET /api/t3/threads/pull-request — read-side identity bound", () => {
  beforeEach(() => {
    process.env.HELM_APP_URL = ORIGIN;
    mocks.action.mockResolvedValue({ status: "no_pr" });
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
    mocks.action.mockReset();
    vi.restoreAllMocks();
  });

  it("accepts a delegated-task id longer than the old 128-character bound", async () => {
    expect(DELEGATED.length).toBeGreaterThan(128);
    const response = await GET(request(DELEGATED));
    expect(response.status).toBe(200);
    // Identity behaviour is otherwise unchanged: the literal id is forwarded
    // to the existing verification action.
    expect(mocks.action).toHaveBeenCalledWith(expect.anything(), {
      connectionId: "conn1",
      projectId: "t3-proj-1",
      threadId: DELEGATED,
    });
    expect(await response.json()).toEqual({ status: "no_pr" });
  });

  it("still refuses an over-bound thread id before any backend call", async () => {
    const over = `thread:provider:codex:native-thread:${"a".repeat(MAX_T3_THREAD_ID_READ_LENGTH)}`;
    const response = await GET(request(over));
    expect(response.status).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
