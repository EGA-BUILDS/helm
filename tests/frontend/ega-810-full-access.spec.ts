import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * EGA-810 Full-access UI coverage. MOCKED INTEGRATION COVERAGE against a
 * stubbed `/api/t3/*` boundary: no live T3 endpoint, consent page or
 * credential is involved. Every assertion below runs against the real
 * dashboard components and controller.
 */

const environment = {
  environmentId: "env_studio",
  label: "Studio",
  serverVersion: "3.2.1",
  platform: "linux",
  metadata: null,
};

const fullAccessConnection = {
  connectionId: "conn_full",
  displayName: "Studio",
  endpoint: "https://studio.t3coderelay.com/mcp",
  environmentId: "env_studio",
  access: "full-access",
  status: "connected",
  lastVerifiedAt: "2026-11-04T00:00:00.000Z",
  lastReadAt: "2026-11-04T01:00:00.000Z",
  errorCode: null,
  expiresAt: "2026-12-04T00:00:00.000Z",
};

const readOnlyConnection = {
  ...fullAccessConnection,
  connectionId: "conn_read",
  displayName: "Studio read",
  access: "read-only",
};

const catalog = {
  providers: [],
  features: {
    appOwnedSubagents: null, asyncPolling: null, cancellation: null, batchThreadCreation: null,
    threadManagement: null, incrementalThreadRead: null, scheduledTasks: null, maxBatchThreads: null,
  },
  runtimeMode: null,
  interactionMode: null,
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
};

const envelope = (data: unknown) => ({
  data,
  observedAt: "2026-11-04T01:00:00.000Z",
  freshness: { source: "backend", observedAt: "2026-11-04T01:00:00.000Z", stale: false },
});

function fulfill(route: Route, body: unknown, status = 200) {
  void route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubFullAccessApi(page: Page, connections: unknown[]) {
  const mutations: string[] = [];
  await page.route("**/api/t3/connections", (route) => fulfill(route, { connections }));
  await page.route("**/api/t3/connections/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/environment")) return fulfill(route, envelope(environment));
    if (path.endsWith("/capabilities")) return fulfill(route, envelope(catalog));
    if (path.endsWith("/projects")) {
      return fulfill(route, envelope({ items: [], nextCursor: null, total: 0, freshness: envelope({}).freshness }));
    }
    if (path.endsWith("/threads")) {
      return fulfill(route, envelope({ items: [], nextCursor: null, total: 0, freshness: envelope({}).freshness }));
    }
    return fulfill(route, { error: { code: "not_found", message: "This T3 read is unavailable.", retryable: false } }, 404);
  });
  await page.route("**/api/t3/oauth/start", (route) => {
    mutations.push(route.request().postData() ?? "{}");
    return fulfill(route, { attemptId: "att_test", authorizationUrl: "https://studio.t3coderelay.com/authorize?attempt=att_test", expiresAt: "2026-11-04T02:00:00.000Z" });
  });
  await page.route("**t3coderelay.com**", (route) => {
    void route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>T3 consent</title><main>T3 consent</main>" });
  });
  return mutations;
}

test("full-access is the default for a new connection and names the T3 Full access mode", async ({ page }) => {
  await stubFullAccessApi(page, []);
  await page.goto("/");
  await expect(page.getByLabel("T3 MCP endpoint", { exact: true })).toBeEnabled();
  // The default for a NEW connection is Full access, not Read only.
  await expect(page.getByRole("radio", { name: /full access/iu })).toBeChecked();
  const guidance = page.getByRole("note");
  await expect(guidance).toContainText("choose Full access");
  await expect(guidance).toContainText("T3 decides which permissions to grant");
  // The dashboard names the compatible T3 mode and separates OAuth Full access
  // from a thread's runtime mode.
  await expect(page.getByText(/Full access → T3/u)).toBeVisible();
  await expect(page.getByText(/OAuth Full access is Helm/u)).toBeVisible();
});

test("read-only and operate choices still render with their own T3 guidance", async ({ page }) => {
  await stubFullAccessApi(page, []);
  await page.goto("/");
  const guidance = page.getByRole("note");
  await page.getByRole("radio", { name: /read only/iu }).check();
  await expect(guidance).toContainText("choose Read only");
  await page.getByRole("radio", { name: /operate/iu }).check();
  await expect(guidance).toContainText("choose Supervised (recommended)");
});

test("starting full-access uses T3's native OAuth consent flow", async ({ page }) => {
  const mutations = await stubFullAccessApi(page, []);
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  await expect(page.getByText("T3 consent")).toBeVisible();
  expect(mutations).toHaveLength(1);
  expect(JSON.parse(mutations[0]!)).toEqual({
    endpoint: "https://studio.t3coderelay.com/mcp",
    access: "full-access",
  });
});

test("a saved full-access connection shows the verified tier, identity, version and health", async ({ page }) => {
  await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  // The tier shown comes from the authenticated inventory, never a URL hint.
  const region = page.getByRole("region", { name: "Environments" });
  await expect(region.getByText("Full access", { exact: true }).first()).toBeVisible();
  await expect(region.getByText("env_studio", { exact: true }).first()).toBeVisible();
  await expect(region.getByText("3.2.1", { exact: true })).toBeVisible();
  await expect(region.getByText("linux", { exact: true }).first()).toBeVisible();
  await expect(region.getByText("Connected", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Reconnecting keeps this level")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another access level", exact: true })).toBeVisible();
});

test("reconnect preserves full-access instead of implying an upgrade", async ({ page }) => {
  const mutations = await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).first().click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  expect(mutations).toHaveLength(1);
  // The saved tier is forwarded explicitly with the saved connection id, so
  // the backend re-verifies the SAME grant.
  expect(JSON.parse(mutations[0]!)).toEqual({ connectionId: "conn_full", access: "full-access" });
});

test("a weaker full-access grant shows the exact remedy with a safe reconnect path", async ({ page }) => {
  await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/?t3=failed&t3_reason=full_access_mode_read_only#connect");
  // The specific fixed message names what T3 granted and what to pick instead,
  // and it is visible when the callback lands on Connect. A message rendered
  // only in #overview would sit above the viewport and look like success.
  await expect(page.getByText(
    "T3 granted Read only instead of Full access. Try again and select Full access on T3's approval screen.",
  )).toBeInViewport();
  // The sticky outcome must not cover the section heading it lands on.
  await expect(page.getByRole("heading", { name: "Connect your workspace", exact: true })).toBeInViewport();
  // The old grant is unchanged and still offers its own reconnect path; no
  // silent retry and no saved weaker tier.
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
  await expect(page.getByText("Reconnecting keeps this level")).toBeVisible();
  // The owner lands on the Connect screen, with no OAuth detail left behind.
  await expect(page.getByRole("link", { name: "Connect T3", exact: true })).toHaveAttribute("aria-current", "location");
  expect(page.url()).not.toContain("t3_reason");
  expect(page.url()).not.toContain("code=");
});

test("a denied consent is visible on the Connect landing screen", async ({ page }) => {
  await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/?t3=denied#connect");
  await expect(page.getByText("T3 consent was declined. No new access was granted.")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect T3", exact: true })).toHaveAttribute("aria-current", "location");
});

test("a mismatched full-access grant shows the exact remedy", async ({ page }) => {
  await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/?t3=failed&t3_reason=full_access_mode_operate#connect");
  await expect(page.getByText(
    "T3 granted Operate instead of Full access. Try again and select Full access on T3's approval screen.",
  )).toBeInViewport();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
});

test("read-only and operate connections keep their own tiers and management", async ({ page }) => {
  await stubFullAccessApi(page, [readOnlyConnection, { ...fullAccessConnection, status: "expired", errorCode: null }]);
  await page.goto("/");
  const region = page.getByRole("region", { name: "Environments" });
  await expect(region.getByText("Read only", { exact: true }).first()).toBeVisible();
  await expect(region.getByText("Expired", { exact: true }).first()).toBeVisible();
  // The expired full-access grant is still managed on its own terms.
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
});

test("callback outcomes carry no token, secret or authorization code", async ({ page }) => {
  await stubFullAccessApi(page, [fullAccessConnection]);
  await page.goto("/?t3=connected&t3_access=full-access#connect");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  const url = page.url();
  expect(url).not.toMatch(/[?&](code|state|token|secret|id_token)=/u);
  const dom = await page.content();
  expect(dom).not.toContain("authorization_code");
  expect(dom).not.toContain("client_secret");
  expect(dom).not.toContain("eyJhbGci");
});
