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
const SECRET_CODE = "code-placeholder-secret";
const SECRET_STATE = "s".repeat(43);

function callbackRequest(query = `state=${SECRET_STATE}&code=${SECRET_CODE}&iss=https%3A%2F%2Fstudio.t3coderelay.com`) {
  return new Request(`${ORIGIN}/api/t3/callback?${query}`);
}

function location(response: Response): URL {
  const value = response.headers.get("location");
  if (!value) throw new Error("expected a redirect location");
  return new URL(value);
}

describe("GET /api/t3/callback", () => {
  beforeEach(() => {
    process.env.HELM_APP_URL = ORIGIN;
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
    mocks.action.mockReset();
    vi.restoreAllMocks();
  });

  it("carries the verified access tier as a bounded selection hint", async () => {
    mocks.action.mockResolvedValue({ connectionId: "conn_ops", status: "connected", access: "operate" });
    const response = await GET(callbackRequest());
    const url = location(response);
    expect(url.searchParams.get("t3")).toBe("connected");
    expect(url.searchParams.get("t3_access")).toBe("operate");
    expect(url.searchParams.get("t3_reason")).toBeNull();
    // No OAuth material survives in the redirect.
    expect(url.search).not.toContain(SECRET_CODE);
    expect(url.search).not.toContain(SECRET_STATE);
  });

  it("carries a fixed scope reason for an actionable failure", async () => {
    mocks.action.mockResolvedValue({ connectionId: null, status: "failed", reason: "operate_mode_full_access" });
    const url = location(await GET(callbackRequest()));
    expect(url.searchParams.get("t3")).toBe("failed");
    expect(url.searchParams.get("t3_reason")).toBe("operate_mode_full_access");
    expect(url.searchParams.get("t3_access")).toBeNull();
  });

  it("drops an unknown reason instead of reflecting it", async () => {
    mocks.action.mockResolvedValue({ connectionId: null, status: "failed", reason: "orchestration:read" });
    const url = location(await GET(callbackRequest()));
    expect(url.searchParams.get("t3")).toBe("failed");
    expect(url.searchParams.get("t3_reason")).toBeNull();
  });

  it("keeps denied and expired outcomes distinct", async () => {
    mocks.action.mockResolvedValueOnce({ connectionId: null, status: "denied" });
    expect(location(await GET(callbackRequest())).searchParams.get("t3")).toBe("denied");
    mocks.action.mockResolvedValueOnce({ connectionId: null, status: "expired" });
    expect(location(await GET(callbackRequest())).searchParams.get("t3")).toBe("expired");
  });

  it("falls back to the generic failure when the backend throws", async () => {
    mocks.action.mockRejectedValue(new Error("T3 connection could not be completed"));
    const url = location(await GET(callbackRequest()));
    expect(url.searchParams.get("t3")).toBe("failed");
    expect(url.searchParams.get("t3_reason")).toBeNull();
    expect(url.search).not.toContain(SECRET_CODE);
  });

  it("refuses duplicate OAuth parameters before calling the backend", async () => {
    const url = location(await GET(callbackRequest(`state=${SECRET_STATE}&state=${SECRET_STATE}&code=${SECRET_CODE}`)));
    expect(url.searchParams.get("t3")).toBe("failed");
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
