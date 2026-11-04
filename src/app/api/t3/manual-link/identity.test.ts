import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("../../../../lib/t3Backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/t3Backend")>();
  return {
    ...actual,
    ownerConvexClient: async () => ({ action: mocks.action }),
  };
});

import { GET } from "./route";

const ORIGIN = "https://helm.example";
const DELEGATED =
  "thread:delegated-task:command%3Amcp%3A6a3438e6-1f36-46fc-9940-4966e6d273df%3Adelegate-task%3A3676395b-913d-4bb5-887e-9fb3089e4bb2";

function request(threadId: string, projectId = "t3-proj-1"): Request {
  const query = new URLSearchParams({ connectionId: "conn1", projectId, threadId });
  return new Request(`${ORIGIN}/api/t3/manual-link?${query.toString()}`, {
    headers: { referer: `${ORIGIN}/dashboard` },
  });
}

describe("GET /api/t3/manual-link — read identity handling", () => {
  beforeEach(() => {
    process.env.HELM_APP_URL = ORIGIN;
    mocks.action.mockResolvedValue({ association: null });
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
    mocks.action.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards a delegated-task id literally, with no extra decode", async () => {
    expect(DELEGATED.length).toBeGreaterThan(128);
    const response = await GET(request(DELEGATED));
    expect(response.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(expect.anything(), {
      connectionId: "conn1",
      projectId: "t3-proj-1",
      threadId: DELEGATED,
    });
    expect(await response.json()).toEqual({ association: null });
  });

  it("maps an invalid identity refusal to a 400 with safe copy, not a 502", async () => {
    mocks.action.mockRejectedValue(new Error("The T3 thread identity is invalid"));
    const response = await GET(request("thread:whatever"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("Select a supported T3 thread to read its association.");
  });

  it("maps a cross-project binding to a conflict, not a successful read", async () => {
    mocks.action.mockRejectedValue(new Error("T3 thread belongs to a different project"));
    const response = await GET(request(DELEGATED));
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("returns a null association for a valid unlinked thread", async () => {
    const response = await GET(request(DELEGATED));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ association: null });
  });
});
