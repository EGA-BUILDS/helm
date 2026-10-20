import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

/**
 * EGA-763 / Phase C F1 — the manual-linking READ must work in a real browser.
 *
 * Browsers do NOT attach an `Origin` header to a same-origin `GET`. A guard
 * that demands one therefore refuses every legitimate read: the owner would
 * see "could not read the current association" and, after a *successful* link,
 * an error claiming the deployment is misconfigured.
 *
 * The rule is: a present `Origin` must equal the configured origin; otherwise
 * the `Referer` must stay under it. A bare navigation with neither header is
 * refused. The state-changing POSTs keep using the strict check.
 */
describe("GET /api/t3/manual-link — same-origin guard", () => {
  const origin = "https://helm.example.com";
  const url = `${origin}/api/t3/manual-link?connectionId=c-1&projectId=p-1&threadId=t-1`;

  beforeEach(() => {
    process.env.HELM_APP_URL = origin;
  });

  afterEach(() => {
    delete process.env.HELM_APP_URL;
  });

  async function errorCode(response: Response): Promise<string | undefined> {
    const body = (await response.json()) as { error?: { code?: string } };
    return body?.error?.code;
  }

  it("accepts a browser same-origin GET that carries a Referer but no Origin header", async () => {
    const request = new Request(url, { headers: { referer: `${origin}/dashboard` } });
    const response = await GET(request);
    // It must NOT be refused as cross-origin. It may still fail later, on the
    // absent Clerk/Convex configuration — that is a different, expected error.
    expect(await errorCode(response)).not.toBe("origin_mismatch");
  });

  it("still refuses a foreign Origin", async () => {
    const request = new Request(url, { headers: { origin: "https://evil.example" } });
    const response = await GET(request);
    expect(await errorCode(response)).toBe("origin_mismatch");
  });

  it("accepts an Origin that matches the configured origin exactly", async () => {
    const request = new Request(url, { headers: { origin } });
    const response = await GET(request);
    expect(await errorCode(response)).not.toBe("origin_mismatch");
  });

  it("refuses a bare navigation carrying neither header", async () => {
    const request = new Request(url);
    const response = await GET(request);
    expect(await errorCode(response)).toBe("origin_mismatch");
  });

  it("refuses a Referer that points at another origin", async () => {
    const request = new Request(url, { headers: { referer: "https://evil.example/dashboard" } });
    const response = await GET(request);
    expect(await errorCode(response)).toBe("origin_mismatch");
  });
});
