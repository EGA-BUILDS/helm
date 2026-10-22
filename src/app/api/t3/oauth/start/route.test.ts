import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("../../../../../lib/t3Backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/t3Backend")>();
  return {
    ...actual,
    ownerConvexClient: async () => ({ action: mocks.action }),
  };
});

import { POST } from "./route";

const ORIGIN = "https://helm.example";

function request(body: unknown) {
  return new Request(`${ORIGIN}/api/t3/oauth/start`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/t3/oauth/start", () => {
  beforeEach(() => {
    process.env.HELM_APP_URL = ORIGIN;
    mocks.action.mockResolvedValue({
      attemptId: "att_test",
      authorizationUrl: "https://studio.t3coderelay.com/oauth/mcp/authorize?scope=placeholder",
      expiresAt: Date.now() + 600_000,
    });
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
    mocks.action.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards an operate request without a connection id", async () => {
    const response = await POST(request({ endpoint: "https://studio.t3coderelay.com/mcp", access: "operate" }));
    expect(response.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(
      expect.anything(),
      { endpoint: "https://studio.t3coderelay.com/mcp", access: "operate" },
    );
    const body = await response.json() as { attemptId: string; authorizationUrl: string };
    expect(body.attemptId).toBe("att_test");
    expect(body.authorizationUrl).toContain("t3coderelay.com");
  });

  it("forwards a read-only request unchanged", async () => {
    const response = await POST(request({ endpoint: "https://studio.t3coderelay.com/mcp", access: "read-only" }));
    expect(response.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(
      expect.anything(),
      { endpoint: "https://studio.t3coderelay.com/mcp", access: "read-only" },
    );
  });

  it("rejects an unsupported access tier before calling the backend", async () => {
    const response = await POST(request({ endpoint: "https://studio.t3coderelay.com/mcp", access: "full-access" }));
    expect(response.status).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_endpoint");
  });

  it("rejects a cross-origin request", async () => {
    const crossOrigin = new Request(`${ORIGIN}/api/t3/oauth/start`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://studio.t3coderelay.com/mcp", access: "operate" }),
    });
    const response = await POST(crossOrigin);
    expect(response.status).toBe(502);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
