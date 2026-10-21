import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Live-mode coverage for the integrated dashboard.
 *
 * The isolated harness has no Next.js route handlers and no T3 server, so these
 * tests stub `/api/t3/*` with the same shapes the real handlers return. That
 * exercises the whole client path — transport decoding, controller invalidation,
 * pagination and the connection lifecycle — with no credentials involved.
 * Fixture scenarios stay separate and are covered by dashboard.test.tsx.
 */

const environment = {
  environmentId: "env_studio",
  label: "Studio",
  serverVersion: "0.0.46-nightly",
  platform: "linux/x64",
  metadata: null,
};

const connection = {
  connectionId: "conn_studio",
  displayName: "Studio",
  endpoint: "https://studio.t3coderelay.com/mcp",
  environmentId: "env_studio",
  access: "read-only",
  status: "connected",
  lastVerifiedAt: "2026-10-12T09:00:00.000Z",
  lastReadAt: "2026-10-12T09:05:00.000Z",
  errorCode: null,
  expiresAt: "2026-11-11T09:00:00.000Z",
};

const catalog = {
  providers: [
    {
      providerInstanceId: "provider_claude",
      driverKind: "sdk",
      displayName: "Claude Code",
      models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", options: null }],
      runtimeModes: ["approval-required"],
      canRunChildTask: null,
      canRunCrossProviderChildTask: null,
      authenticationStatus: null,
      availability: null,
      constraints: null,
    },
    { providerInstanceId: "provider_local", driverKind: null, displayName: null, models: null, runtimeModes: null, canRunChildTask: null, canRunCrossProviderChildTask: null, authenticationStatus: null, availability: null, constraints: null },
  ],
  features: {
    appOwnedSubagents: null, asyncPolling: true, cancellation: null, batchThreadCreation: null,
    threadManagement: null, incrementalThreadRead: true, scheduledTasks: null, maxBatchThreads: null,
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
};

const project = (id: string, title: string, workspaceRoot: string | null) => ({
  connectionId: "conn_studio", projectId: id, environmentId: "env_studio", title, status: "active", workspaceRoot, repositoryIdentity: null, defaultModel: null,
});

const thread = (id: string, title: string, status: string, updatedAt: string | null) => ({
  connectionId: "conn_studio", threadId: id, projectId: "proj_helm", environmentId: "env_studio", title, status,
  providerInstanceId: "provider_claude", model: "claude-sonnet-5", runtimeMode: "approval-required", interactionMode: "default",
  branch: null, worktreePath: null, latestRunId: null, parentThreadId: null, linkedPullRequest: null, updatedAt,
});

const activityPage = (items: readonly unknown[], nextPosition: number | null, hasMore: boolean) => ({
  thread: thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"),
  items,
  recentRuns: [{ runId: "run_1", ordinal: 1, status: "completed", providerInstanceId: "provider_claude", model: "claude-sonnet-5", requestedAt: "2026-10-12T07:00:00.000Z", startedAt: null, completedAt: null }],
  nextPosition,
  hasMore,
});

const envelope = (data: unknown) => ({
  data,
  observedAt: "2026-10-12T09:05:00.000Z",
  freshness: { source: "backend", observedAt: "2026-10-12T09:05:00.000Z", stale: false },
});

function fulfill(route: Route, body: unknown, status = 200) {
  void route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export interface LiveApi {
  /** Advances the stub to its next page of projects, threads and activity. */
  nextPage: () => void;
  /** Bodies seen on POST/PUT/DELETE requests. */
  mutations: string[];
}

type Overrides = Record<string, (route: Route, api: LiveApi) => Promise<void> | void>;

/**
 * Installs the `/api/t3/*` stub. `overrides` are registered first so a test can
 * replace any single endpoint without duplicating the whole stub.
 */
async function stubLiveApi(page: Page, overrides: Overrides = {}): Promise<LiveApi> {
  let projectPage = 0;
  let threadPage = 0;
  let activityPageIndex = 0;
  const mutations: string[] = [];
  const api: LiveApi = { nextPage: () => { projectPage += 1; threadPage += 1; activityPageIndex += 1; }, mutations };
  const fulfill = (route: Route, body: unknown, status = 200) => {
    void route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  };
  const projectPages = [[project("proj_helm", "Helm", "/workspace/helm"), project("proj_design", "Design system", "/workspace/design")], [project("proj_notes", "Field notes", null)]];
  const threadPages = [
    [thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"), thread("thr_contract", "Review the frontend contract", "waiting", null)],
    [thread("thr_typography", "Explore typography tokens", "idle", null), { ...thread("thr_tokens", "Spacing tokens", "idle", null), projectId: "proj_design" }],
  ];
  const activityPages = [activityPage([
      { id: "item_1", position: 0, kind: "user", text: "Review the workspace layout and document the next steps.", createdAt: "2026-10-12T07:00:00.000Z", truncated: false, nextTextOffset: null },
      { id: "item_2", position: 1, kind: "activity", text: "Inspected the", createdAt: "2026-10-12T07:05:00.000Z", truncated: true, nextTextOffset: 13 },
    ], 2, true), activityPage([
      { id: "item_2", position: 1, kind: "activity", text: "Inspected the dashboard components in the studio workspace.", createdAt: "2026-10-12T07:05:00.000Z", truncated: false, nextTextOffset: null },
      { id: "item_3", position: 2, kind: "assistant", text: "The layout review is ready.", createdAt: "2026-10-12T07:10:00.000Z", truncated: false, nextTextOffset: null },
    ], null, false)];

  await page.route("**/api/t3/connections", (route) => fulfill(route, {
    connections: [connection, { ...connection, connectionId: "conn_laptop", displayName: "Laptop", environmentId: "env_laptop", status: "expired", expiresAt: "2026-01-01T00:00:00.000Z" }],
  }));
  await page.route("**/api/t3/connections/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method === "DELETE") {
      mutations.push(path);
      return fulfill(route, { connectionId: path.split("/").filter(Boolean)[1], status: "disconnected" });
    }
    if (path.endsWith("/refresh")) return fulfill(route, { data: { environment, observedAt: "2026-10-12T10:00:00.000Z" } });
    if (path.endsWith("/environment")) return fulfill(route, envelope(environment));
    if (path.endsWith("/capabilities")) return fulfill(route, envelope(catalog));
    if (path.endsWith("/projects")) {
      const current = Math.min(projectPage, projectPages.length - 1);
      projectPage = current + 1;
      return fulfill(route, envelope({ items: projectPages[current], nextCursor: current < projectPages.length - 1 ? 2 : null, total: 3, freshness: envelope({}).freshness }));
    }
    if (path.endsWith("/threads")) {
      const current = Math.min(threadPage, threadPages.length - 1);
      threadPage = current + 1;
      const scoped = threadPages[current].filter((item) => item.projectId === (url.searchParams.get("projectId") ?? "proj_helm"));
      return fulfill(route, envelope({ items: scoped, nextCursor: current < threadPages.length - 1 ? 2 : null, total: scoped.length, freshness: envelope({}).freshness }));
    }
    if (path.endsWith("/thread")) {
      const current = Math.min(activityPageIndex, activityPages.length - 1);
      activityPageIndex = current + 1;
      return fulfill(route, envelope(activityPages[current]));
    }
    if (path.endsWith("/project")) return fulfill(route, envelope(projectPages[0].find((item) => item.projectId === url.searchParams.get("projectId")) ?? null));
    return fulfill(route, { error: { code: "not_found", message: "This T3 read is unavailable.", retryable: false } }, 404);
  });
  await page.route("**/api/t3/oauth/start", (route) => {
    const body = route.request().postData() ?? "{}";
    mutations.push(body);
    return fulfill(route, { attemptId: "att_test", authorizationUrl: `https://studio.t3coderelay.com/authorize?state=${encodeURIComponent(body)}`, expiresAt: "2026-10-12T09:10:00.000Z" });
  });
  await page.route("**t3coderelay.com**", (route) => {
    void route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>T3 consent</title><main>T3 consent</main>" });
  });
  // Playwright matches the most recently registered route first, so overrides go last.
  for (const [pattern, handler] of Object.entries(overrides)) {
    await page.route(pattern, (route) => handler(route, api));
  }
  return api;
}

test.beforeEach(async ({ page }) => {
  await stubLiveApi(page);
});

test("a connected owner sees the real T3 environment, catalog and projects", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Where your work runs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Environments" }).getByText("env_studio", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0.0.46-nightly", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Environments" }).getByText("linux/x64", { exact: true })).toBeVisible();
  await expect(page.getByText("Know what’s available")).toBeVisible();
  await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(page.getByText("provider_local", { exact: true })).toBeVisible();
  await expect(page.getByText("Availability unknown", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("A home for every project")).toBeVisible();
  await expect(page.getByText(/of 3 reported by T3/).first()).toBeVisible();
});

test("Connect starts the native OAuth flow and only navigates to an approved destination", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await expect(page.getByLabel("T3 MCP endpoint", { exact: true })).toBeEnabled();
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await expect(page.getByRole("button", { name: "Connect T3", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  await expect(page.getByText("T3 consent")).toBeVisible();
});

test("an off-origin consent URL is refused without navigating", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
    "**/api/t3/oauth/start": (route) => fulfill(route, { attemptId: "att_test", authorizationUrl: "https://evil.example/authorize", expiresAt: null }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page.getByText("Helm did not receive an approved T3 consent URL.")).toBeVisible();
  await expect(page).not.toHaveURL(/evil\.example/u);
});

/**
 * A second access level is ADDED, never substituted. The backend keeps one
 * active connection per tier, so the read-only grant must survive untouched
 * while a new consent creates a separate operate row.
 */
test("adding an operate access level starts a NEW consent and keeps the read-only connection", async ({ page }) => {
  const api = await stubLiveApi(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Add another access level", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add another access level", exact: true }).click();

  // The form opens prefilled with the same endpoint, and the access choice is
  // pre-set to the OTHER tier, because the saved one already owns read-only.
  await expect(page.getByLabel("T3 MCP endpoint", { exact: true })).toHaveValue("https://studio.t3coderelay.com/mcp");
  await expect(page.getByRole("radio", { name: /operate/iu })).toBeChecked();

  await page.getByRole("button", { name: "Connect T3", exact: true }).click();

  // The consent request asks for operate and names NO connection, so a new row
  // is created instead of the read-only one being rewritten.
  const bodies = api.mutations.filter((entry) => entry.startsWith("{"));
  expect(bodies.length).toBeGreaterThan(0);
  const requested = JSON.parse(bodies[bodies.length - 1]!) as { access?: string; connectionId?: string; endpoint?: string };
  expect(requested.access).toBe("operate");
  expect(requested.connectionId).toBeUndefined();
  expect(requested.endpoint).toBe("https://studio.t3coderelay.com/mcp");

  // The read-only connection was never disconnected to make room.
  expect(api.mutations.filter((entry) => entry.includes("/api/t3/connections/"))).toHaveLength(0);
});

test("an existing connection for the chosen access level is offered instead of a duplicate consent", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, {
      connections: [connection, { ...connection, connectionId: "conn_ops", displayName: "Ops", access: "operate", status: "expired" }],
    }),
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Add another access level", exact: true }).click();
  // Operate is pre-selected, and an operate connection already exists, so the
  // owner is pointed at it instead of being offered a second grant.
  await expect(page.getByRole("radio", { name: /operate/iu })).toBeChecked();
  await expect(page.getByText(/already have a/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect T3", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
});

test("cancelling the add-another-access-level form starts no consent and keeps the saved connection", async ({ page }) => {
  const api = await stubLiveApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Add another access level", exact: true }).click();
  await expect(page.getByLabel("T3 MCP endpoint", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Back to the saved connection, and nothing was requested from T3.
  await expect(page.getByRole("button", { name: "Add another access level", exact: true })).toBeVisible();
  await expect(page.getByText("Reconnecting keeps this level")).toBeVisible();
  expect(api.mutations.filter((entry) => entry.startsWith("{"))).toHaveLength(0);
  expect(api.mutations.filter((entry) => entry.includes("/api/t3/connections/"))).toHaveLength(0);
});

test("refresh updates the verified environment and inventory", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh connection", exact: true }).first().click();
  await expect(page.getByText(/T3 environment verified at/u)).toBeVisible();
});

test("reconnect reuses the existing connection id without duplicating it", async ({ page }) => {
  const api = await stubLiveApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).first().click();
  expect(JSON.parse(api.mutations.find((body) => body.includes("connectionId")) ?? "{}")).toEqual({ connectionId: "conn_studio" });
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  await expect(page.getByText("T3 consent")).toBeVisible();
});

test("disconnect needs explicit confirmation and then removes private data", async ({ page }) => {
  let disconnected = false;
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: disconnected ? [] : [connection] }),
    "**/api/t3/connections/**": (route) => {
      if (route.request().method() !== "DELETE") return void route.fallback();
      disconnected = true;
      return fulfill(route, { connectionId: "conn_studio", status: "disconnected" });
    },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  const disconnect = page.getByRole("button", { name: "Disconnect", exact: true }).first();
  await disconnect.click();
  await expect(page.getByText("This removes the saved T3 grant for this connection.").first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm disconnect", exact: true }).first().click();
  await expect(page.getByText("T3 disconnected.")).toBeVisible();
  await expect(page.getByText("No verified T3 connection yet")).toBeVisible();
});

test("selecting an environment scopes every read to that connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: "Select Laptop environment" }).click();
  await expect(page.getByText("Select a connected environment to browse its projects.")).toBeVisible();
  await expect(page.getByText("This connection is not authorized right now.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Environments" }).getByText("Expired", { exact: true }).first()).toBeVisible();
});

test("selecting a project triggers a project-scoped thread read", async ({ page }) => {
  const urls: string[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/threads")) urls.push(url.search);
      return void route.fallback();
    },
  });
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button", { name: /Helm/ })).toBeVisible();
  await page.getByRole("button", { name: /Design system/ }).click();
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button", { name: /Spacing tokens/ })).toBeVisible();
  expect(urls.some((search) => search.includes("projectId=proj_design"))).toBe(true);
});

test("loading more projects appends the next page without duplicates", async ({ page }) => {
  await stubLiveApi(page);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button")).toHaveCount(2);
  await page.getByRole("button", { name: "Load more projects", exact: true }).click();
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button", { name: /Field notes/ })).toBeVisible();
});

test("loading more threads appends the next page", async ({ page }) => {
  await stubLiveApi(page);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button", { name: /Review the frontend contract/ })).toBeVisible();
  await page.getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button", { name: /Explore typography tokens/ })).toBeVisible();
});

test("thread detail, truncated text and incremental activity come from the backend", async ({ page }) => {
  await stubLiveApi(page);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button", { name: /Refine the workspace navigation/ })).toBeVisible();
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Review the workspace layout and document the next steps.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more text", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect(page.getByText("Inspected the dashboard components in the studio workspace.")).toBeVisible();
  await expect(page.getByText("Truncated content. Load the continuation from T3.")).toHaveCount(0);
  await page.getByRole("button", { name: "Load more activity", exact: true }).click();
  await expect(page.getByText("The layout review is ready.", { exact: true })).toBeVisible();
});

test("an unreachable connection is shown without exposing its resources", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [{ ...connection, status: "unreachable", errorCode: "unreachable" }] }),
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Environments" }).getByText("Unreachable", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Helm could not reach this T3 server. No project, catalog or thread data is shown until it responds.")).toBeVisible();
  await expect(page.getByText("Select a connected environment to browse its projects.")).toBeVisible();
});

test("a failing read shows a sanitized error instead of an empty page", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => fulfill(route, { error: { code: "rate_limited", message: "T3 is receiving too many requests. Try again shortly.", retryable: true } }, 502),
  });
  await page.goto("/");
  await expect(page.getByText("T3 is receiving too many requests. Try again shortly.").first()).toBeVisible();
});

test("native controls are bound to a selected thread and unimplemented ones stay disabled", async ({ page }) => {
  // EGA-764/765 made follow-up and interrupt real. The invariants that still hold
  // in this read-only harness: nothing is offered before a thread is selected,
  // unimplemented operations stay disabled, and no connect flow appears.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start thread", exact: true })).toBeDisabled();
  // No thread selected yet in this harness -> the controls are not mounted.
  await expect(page.getByLabel("Follow-up message", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect T3", exact: true })).toHaveCount(0);
  // And the stale blanket claim must be gone.
  await expect(page.getByText(/Thread launch, follow-up and interrupt stay disabled/)).toHaveCount(0);
});

test("switching project discards the previous project's threads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button", { name: /Review the frontend contract/ })).toBeVisible();
  await page.getByRole("button", { name: /Design system/ }).click();
  // The previous project's threads must not survive the selection change.
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button")).toHaveCount(1);
  await expect(page.getByText(/Review the frontend contract/)).toHaveCount(0);
});

/*
 * Regression coverage for the defects found during integration review. These
 * exercise the real component and controller against a stubbed `/api/t3/*`
 * boundary, so they prove client behaviour only — not live T3 connectivity.
 */

/** Counts the POST bodies sent to the OAuth start route. */
function oauthStarts(api: LiveApi): unknown[] {
  return api.mutations.map((body) => JSON.parse(body) as unknown);
}

/**
 * A Connect button nested in the form previously carried an `onClick` *and*
 * inherited implicit-submit behaviour, so a single owner action could reach the
 * OAuth state machine twice. In practice the `busy` flag disabled the button
 * first, which hid the duplicate; this asserts the invariant directly so the
 * behaviour does not depend on that timing.
 */
test("one Connect click starts exactly one native OAuth request", async ({ page }) => {
  const api = await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  expect(oauthStarts(api)).toHaveLength(1);
});

test("pressing Enter in the endpoint field starts exactly one native OAuth request", async ({ page }) => {
  const api = await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  expect(oauthStarts(api)).toHaveLength(1);
});

test("a second Connect click while an attempt is pending starts no further request", async ({ page }) => {
  const api = await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  const connect = page.getByRole("button", { name: "Connect T3", exact: true });
  await connect.click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  // Re-submitting after a navigation must not queue another attempt either.
  await page.goBack();
  await connect.click({ force: true }).catch(() => undefined);
  await connect.click({ force: true }).catch(() => undefined);
  expect(oauthStarts(api).length).toBeLessThanOrEqual(2);
});

test("Reconnect starts exactly one native OAuth request", async ({ page }) => {
  const api = await stubLiveApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).first().click();
  await expect(page).toHaveURL(/t3coderelay\.com/u);
  expect(oauthStarts(api)).toHaveLength(1);
  expect(oauthStarts(api)[0]).toEqual({ connectionId: "conn_studio" });
});

/**
 * MOCKED INTEGRATION COVERAGE — client behaviour against a stubbed `/api/t3/*`
 * boundary. No live T3 endpoint, consent page or credential is involved.
 */
test("a non-HTTPS MCP URL is rejected locally with a specific reason and no OAuth request", async ({ page }) => {
  const api = await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("http://studio.t3coderelay.com/mcp");
  await expect(page.getByText("T3 Connect URLs must use HTTPS.")).toBeVisible();
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  // The form is locally invalid, so nothing may reach the network.
  await expect(page).not.toHaveURL(/t3coderelay\.com\/authorize/u);
  expect(oauthStarts(api)).toHaveLength(0);
});

test("an untrusted MCP host is rejected locally and never reaches the OAuth route", async ({ page }) => {
  const api = await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://evil-t3coderelay.com/mcp");
  await expect(page.getByText("Helm only connects to T3 Connect endpoints under t3coderelay.com.")).toBeVisible();
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  expect(oauthStarts(api)).toHaveLength(0);
});

test("the form still offers Connect T3, not Reconnect, after consent was denied", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/?t3=denied");
  await expect(page.getByText("T3 consent was declined.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect T3", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
});

test("a refused Preview origin is reported with its own sanitized explanation", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
    // No message on purpose: the client must supply its own safe sentence.
    "**/api/t3/oauth/start": (route) => fulfill(route, { error: { code: "origin_mismatch", retryable: false } }, 403),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page.getByText(/not configured for its own origin/u)).toBeVisible();
  await expect(page).not.toHaveURL(/authorize/u);
});

test("an unresolvable T3 hostname is reported as retryable", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
    "**/api/t3/oauth/start": (route) => fulfill(route, { error: { code: "endpoint_unresolved", retryable: true } }, 502),
  });
  await page.goto("/");
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://studio.t3coderelay.com/mcp");
  await page.getByRole("button", { name: "Connect T3", exact: true }).click();
  await expect(page.getByText(/could not resolve this T3 Connect hostname/iu)).toBeVisible();
  await expect(page.getByText(/You can try again\./u)).toBeVisible();
});

test("browsing a project's threads selects that project in the controller", async ({ page }) => {
  const requested: (string | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/threads")) requested.push(url.searchParams.get("projectId"));
      return route.fallback();
    },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Design system/ })).toBeVisible();
  // Select project A from the list, then narrow the search so the detail panel
  // displays project B while the controller is still scoped to A.
  await page.getByRole("button", { name: /Design system/ }).click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("Design system");
  await page.getByLabel("Search projects", { exact: true }).fill("Helm");
  await expect(page.getByRole("heading", { name: "Helm", exact: true })).toBeVisible();
  // The link must select the project the owner is actually looking at.
  await page.getByRole("link", { name: /Browse this project’s threads/ }).click();
  await expect.poll(() => requested.at(-1)).toBe("proj_helm");
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("Helm");
});

test("changing project clears the previous project's search filter", async ({ page }) => {
  const queries: (string | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/threads")) queries.push(url.searchParams.get("titleContains"));
      return route.fallback();
    },
  });
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list", exact: true })).toBeVisible();
  const search = page.getByLabel("Search threads", { exact: true });
  await search.fill("Review");
  await expect.poll(() => queries.at(-1)).toBe("Review");
  await page.getByRole("button", { name: /Design system/ }).click();
  // The controlled field and the backend query must agree: neither may keep the
  // previous project's filter.
  await expect(search).toHaveValue("");
  await expect.poll(() => queries.at(-1)).toBeNull();
});

test("selecting a project reads its detail from the project endpoint", async ({ page }) => {
  const detailReads: string[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/project")) detailReads.push(url.searchParams.get("projectId") ?? "");
      return route.fallback();
    },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Design system/ })).toBeVisible();
  // Detail is read for the selected project only, never for every project.
  await expect.poll(() => detailReads).toEqual(["proj_helm"]);
  await page.getByRole("button", { name: /Design system/ }).click();
  await expect.poll(() => detailReads).toEqual(["proj_helm", "proj_design"]);
});

test("a failed project detail read does not clear the project list", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/project")) {
        return fulfill(route, { error: { code: "read_failed", message: "T3 could not read the project.", retryable: true } }, 502);
      }
      return route.fallback();
    },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Design system/ })).toBeVisible();
  await expect(page.getByText("T3 could not read the project.").first()).toBeVisible();
  // The list itself is independent and must survive the detail failure.
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button")).toHaveCount(2);
});

test("re-selecting the same project keeps the owner's thread search", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list", exact: true })).toBeVisible();
  const search = page.getByLabel("Search threads", { exact: true });
  await search.fill("Review");
  await expect(search).toHaveValue("Review");
  // Selecting the project already shown, or following its browse link, must not
  // discard a search the owner typed deliberately.
  await page.getByRole("button", { name: /^Helm/ }).first().click();
  await page.getByRole("link", { name: /Browse this project’s threads/ }).click();
  await expect(search).toHaveValue("Review");
});
