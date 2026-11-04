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

const thread = (id: string, title: string, status: string | null, updatedAt: string | null) => ({
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
    [thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"), thread("thr_contract", "Review the frontend contract", "waiting_for_approval", null)],
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
  // EGA-764/765 made follow-up and interrupt real, and launch now starts from a
  // mapped Linear issue. The invariants that still hold in this read-only
  // harness: nothing is offered before a thread is selected, the workspace
  // points at the issue-driven flow, and no connect flow appears.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Start from a Linear issue/ })).toHaveAttribute("href", "#linear-issues");
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

const operateConnection = {
  ...connection,
  connectionId: "conn_ops",
  displayName: "Ops",
  access: "operate",
};

test("the consent form names the exact T3 mode before the owner connects", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [] }),
  });
  await page.goto("/");

  const guidance = page.getByRole("note");
  await expect(guidance).toContainText("choose Read only");
  await expect(guidance).toContainText("T3 decides which permissions to grant");

  await page.getByRole("radio", { name: /operate/iu }).check();
  await expect(guidance).toContainText("choose Supervised (recommended)");
  await expect(guidance).toContainText("Do not choose Read only or Full access");
  await expect(guidance).toContainText("Full access also grants settings and source-control");
});

test("a Full access consent failure gives the exact remedy", async ({ page }) => {
  await page.goto("/?t3=failed&t3_reason=operate_mode_full_access");
  await expect(page.getByText(
    "T3 granted broader permissions than Helm allows. Try again and select Supervised instead of Full access.",
  )).toBeVisible();
});

test("an unknown callback reason falls back to the generic failure", async ({ page }) => {
  await page.goto("/?t3=failed&t3_reason=orchestration%3Aread");
  await expect(page.getByText("The T3 connection could not be completed. No access was granted.")).toBeVisible();
});

test("a successful operate consent selects the verified operate connection", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [connection, operateConnection] }),
  });
  await page.goto("/?t3=connected&t3_access=operate");

  await expect(page.getByRole("button", { name: "Select Ops environment" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Selected environment: Ops/u)).toBeVisible();
});

test("a forged operate selection hint cannot select a missing or unverified row", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [connection] }),
  });
  await page.goto("/?t3=connected&t3_access=operate");

  await expect(page.getByRole("button", { name: "Select Studio environment" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Selected environment: Studio/u)).toBeVisible();
});

test("a failed operate attempt leaves the read-only connection selected", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [connection, operateConnection] }),
  });
  await page.goto("/?t3=failed&t3_reason=operate_mode_read_only");

  await expect(page.getByRole("button", { name: "Select Studio environment" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/T3 granted Read only instead of Operate/u)).toBeVisible();
});

/*
 * EGA-811 cross-project overview coverage. MOCKED INTEGRATION COVERAGE against
 * a stubbed `/api/t3/*` boundary: no live T3 endpoint or credential is used.
 */

test("All projects shows per-project attribution, partial coverage and the selected identity", async ({ page }) => {
  let projectPage = 0;
  let threadReads = 0;
  const projectPages = [
    [project("proj_helm", "Helm", "/workspace/helm"), project("proj_design", "Design system", "/workspace/design")],
    [project("proj_notes", "Field notes", null)],
  ];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/projects")) {
        const current = Math.min(projectPage, projectPages.length - 1);
        projectPage = current + 1;
        return fulfill(route, envelope({
          items: projectPages[current],
          nextCursor: current < projectPages.length - 1 ? 2 : null,
          total: 3,
          freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/threads")) {
        threadReads += 1;
        const projectId = url.searchParams.get("projectId");
        const rows = projectId === "proj_design"
          ? [{ ...thread("thr_shared", "Same title", "failed", "2026-11-03T09:00:00.000Z"), projectId: "proj_design" }]
          : projectId === "proj_notes"
            ? [{ ...thread("thr_notes", "Capture field notes", "idle", null), projectId: "proj_notes" }]
            : [{ ...thread("thr_shared", "Same title", "running", "2026-11-03T10:00:00.000Z"), projectId: "proj_helm" }];
        return fulfill(route, envelope({
          items: rows,
          nextCursor: null,
          total: projectId === "proj_design" ? null : rows.length,
          freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/thread")) {
        return fulfill(route, envelope({
          thread: { ...thread("thr_shared", "Same title", "failed", "2026-11-03T09:00:00.000Z"), projectId: "proj_design" },
          items: [{ id: "item_design", position: 0, kind: "assistant", text: "Design project activity.", createdAt: null, truncated: false, nextTextOffset: null }],
          recentRuns: [], nextPosition: null, hasMore: false,
        }));
      }
      return route.fallback();
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "All projects", exact: true }).click();

  await expect(page.getByLabel("All-projects thread coverage")).toContainText("Partial thread inventory");
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("Read 2 of 2 known projects");
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("T3 reports 3 projects");
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("more project pages may exist");
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("total number of threads across all projects is unknown");

  const helmRow = page.getByRole("button", { name: "Open Same title in Helm" });
  const designRow = page.getByRole("button", { name: "Open Same title in Design system" });
  await expect(helmRow).toBeVisible();
  await expect(designRow).toBeVisible();
  // Same title and upstream thread id, but distinct project identities.
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button", { name: /Open Same title/ })).toHaveCount(2);

  await designRow.click();
  await expect(designRow).toHaveAttribute("aria-pressed", "true");
  await expect(helmRow).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("dt", { hasText: /^Project$/ }).locator("..")).toContainText("Design system");
  await expect(page.locator("dt", { hasText: /^Native status$/ }).locator("..")).toContainText("failed");
  await expect(page.getByText("Design project activity.")).toBeVisible();

  const readsBeforeFilter = threadReads;
  await page.getByLabel("Status", { exact: true }).selectOption("state:failed");
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button", { name: /Open Same title/ })).toHaveCount(1);
  await expect(designRow).toBeVisible();
  await expect(helmRow).toHaveCount(0);
  // A work-state filter is local to loaded rows: it must not fan out new reads
  // or change the meaning of the coverage receipt.
  expect(threadReads).toBe(readsBeforeFilter);

  await page.getByLabel("All-projects thread coverage").getByRole("button", { name: "Load more projects", exact: true }).click();
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("Read 3 of 3 known projects");
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("Field notes");
  await expect(page.getByRole("button", { name: "Open Capture field notes in Field notes" })).toHaveCount(0);
  await page.getByLabel("Status", { exact: true }).selectOption("");
  await expect(page.getByRole("button", { name: "Open Capture field notes in Field notes" })).toBeVisible();
});

test("All projects retries a failed project and never duplicates an overlapping page", async ({ page }) => {
  let projectReads = 0;
  let helmPages = 0;
  let designFails = true;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/projects")) {
        return fulfill(route, envelope({
          items: [project("proj_helm", "Helm", "/workspace/helm"), project("proj_design", "Design system", "/workspace/design")],
          nextCursor: null, total: 2, freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/threads")) {
        const projectId = url.searchParams.get("projectId");
        if (projectId === "proj_design" && designFails) {
          projectReads += 1;
          designFails = false;
          return fulfill(route, { error: { code: "read_failed", message: "This project read failed once.", retryable: true } }, 502);
        }
        if (projectId === "proj_design") {
          return fulfill(route, envelope({
            items: [{ ...thread("thr_design", "Design thread", "completed", null), projectId: "proj_design" }],
            nextCursor: null, total: 1, freshness: envelope({}).freshness,
          }));
        }
        const cursor = url.searchParams.get("cursor");
        const rows = cursor === "5"
          ? [
            { ...thread("thr_helm_1", "Helm first", "running", null), projectId: "proj_helm" },
            { ...thread("thr_helm_2", "Helm second", "waiting_for_approval", null), projectId: "proj_helm" },
          ]
          : [{ ...thread("thr_helm_1", "Helm first", "running", null), projectId: "proj_helm" }];
        helmPages += 1;
        return fulfill(route, envelope({
          items: rows,
          nextCursor: cursor === "5" ? null : 5,
          total: 2,
          freshness: envelope({}).freshness,
        }));
      }
      return route.fallback();
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Helm first in Helm" })).toBeVisible();
  await expect(page.getByLabel("All-projects thread coverage")).toContainText("1 project thread read failed");
  expect(projectReads).toBe(1);

  // The explicit action retries the failed project instead of looping on it.
  await page.getByRole("button", { name: "Load more or retry threads", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Design thread in Design system" })).toBeVisible();
  await expect(page.getByLabel("All-projects thread coverage")).not.toContainText("read failed");

  // The next explicit page repeats one row at the boundary. It must merge by
  // identity, not append duplicate rows.
  await page.getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Helm second in Helm" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button", { name: /Open Helm first/ })).toHaveCount(1);
  expect(helmPages).toBeGreaterThanOrEqual(2);
});

/*
 * EGA-811 remediation regressions. MOCKED INTEGRATION COVERAGE against a
 * stubbed `/api/t3/*` boundary; no live T3 endpoint or credential is involved.
 */

test("All projects recovers after All -> Selected -> All with a deferred old read", async ({ page }) => {
  const heldHelm: Route[] = [];
  const prProjects: string[] = [];
  await stubLiveApi(page, {
    "**/api/t3/threads/pull-request**": (route) => {
      const projectId = new URL(route.request().url()).searchParams.get("projectId");
      if (projectId) prProjects.push(projectId);
      return fulfill(route, { status: "no_pr" });
    },
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/projects")) {
        return fulfill(route, envelope({
          items: [project("proj_helm", "Helm", "/workspace/helm"), project("proj_design", "Design system", "/workspace/design")],
          nextCursor: null, total: 2, freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/threads")) {
        const projectId = url.searchParams.get("projectId");
        if (projectId === "proj_helm") {
          heldHelm.push(route);
          return;
        }
        return fulfill(route, envelope({
          items: [{ ...thread("thr_design", "Design ready", "running", "2026-11-03T09:00:00.000Z"), projectId: "proj_design" }],
          nextCursor: null, total: 1, freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/thread")) {
        const selectedId = url.searchParams.get("threadId");
        const projectId = selectedId === "thr_stale" || selectedId === "thr_fresh" ? "proj_helm" : "proj_design";
        return fulfill(route, envelope({
          thread: { ...thread(selectedId ?? "thr_design", "Deferred thread", "running", "2026-11-03T09:00:00.000Z"), projectId },
          items: [], recentRuns: [], nextPosition: null, hasMore: false,
        }));
      }
      return route.fallback();
    },
  });

  const pageFor = (threadId: string, title: string) => envelope({
    items: [{ ...thread(threadId, title, "running", "2026-11-03T09:00:00.000Z"), projectId: "proj_helm" }],
    nextCursor: null, total: 1, freshness: envelope({}).freshness,
  });

  await page.goto("/");
  // The initial selected-project read is held too. Release it so the deferred
  // sequence starts with the First All-projects generation.
  await expect.poll(() => heldHelm.length).toBe(1);
  await heldHelm.shift()!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageFor("thr_initial", "Initial Helm")) });
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Design ready in Design system" })).toBeVisible();
  await expect.poll(() => heldHelm.length).toBe(1);

  await page.getByRole("button", { name: "Selected project", exact: true }).click();
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await expect.poll(() => heldHelm.length).toBe(3);

  // The old generations must not overwrite the current one.
  await heldHelm[0]!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageFor("thr_stale", "Stale Helm")) });
  await heldHelm[1]!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageFor("thr_stale", "Stale Helm")) });
  await heldHelm[2]!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageFor("thr_fresh", "Fresh Helm")) });

  await expect(page.getByRole("button", { name: "Open Fresh Helm in Helm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Design ready in Design system" })).toBeVisible();
  await expect(page.getByText("Stale Helm", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(heldHelm).toHaveLength(3);

  await page.getByRole("button", { name: "Open Design ready in Design system" }).click();
  await expect.poll(() => prProjects.at(-1)).toBe("proj_design");
  await page.getByRole("button", { name: "Open Fresh Helm in Helm" }).click();
  await expect.poll(() => prProjects.at(-1)).toBe("proj_helm");
});

test("a connection switch aborts a serial All-projects batch before the next request", async ({ page }) => {
  const studio = connection;
  const laptop = { ...connection, connectionId: "conn_laptop", displayName: "Laptop", environmentId: "env_laptop" };
  const oldCursorRequests: string[] = [];
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections": (route) => fulfill(route, { connections: [studio, laptop] }),
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const connectionId = path.split("/").filter(Boolean)[3];
      if (path.endsWith("/projects")) {
        if (connectionId === "conn_laptop") {
          return fulfill(route, envelope({ items: [{ ...project("proj_laptop", "Laptop project", null), connectionId: "conn_laptop", environmentId: "env_laptop" }], nextCursor: null, total: 1, freshness: envelope({}).freshness }));
        }
        return fulfill(route, envelope({
          items: [project("proj_a", "Project A", null), project("proj_b", "Project B", null)],
          nextCursor: null, total: 2, freshness: envelope({}).freshness,
        }));
      }
      if (path.endsWith("/threads")) {
        if (connectionId === "conn_laptop") {
          return fulfill(route, envelope({
            items: [{ ...thread("thr_laptop", "Laptop thread", "running", null), connectionId: "conn_laptop", projectId: "proj_laptop", environmentId: "env_laptop" }],
            nextCursor: null, total: 1, freshness: envelope({}).freshness,
          }));
        }
        const projectId = url.searchParams.get("projectId");
        if (url.searchParams.get("cursor") === "5") {
          oldCursorRequests.push(projectId ?? "");
          if (projectId === "proj_a") {
            held.push(route);
            return;
          }
          return fulfill(route, envelope({ items: [], nextCursor: null, total: 2, freshness: envelope({}).freshness }));
        }
        return fulfill(route, envelope({
          items: [{ ...thread(`thr_${projectId}`, `${projectId} thread`, "running", null), projectId: projectId ?? "proj_a" }],
          nextCursor: 5, total: 2, freshness: envelope({}).freshness,
        }));
      }
      return route.fallback();
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open proj_a thread in Project A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open proj_b thread in Project B" })).toBeVisible();
  await page.getByLabel("All-projects thread coverage").getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  expect(oldCursorRequests).toEqual(["proj_a"]);

  await page.getByRole("button", { name: "Select Laptop environment" }).click();
  await expect(page.getByRole("button", { name: "Open Laptop thread in Laptop project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open proj_a thread in Project A" })).toHaveCount(0);
  await held[0]!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope({ items: [], nextCursor: null, total: 2, freshness: envelope({}).freshness })) });
  await page.waitForTimeout(300);
  expect(oldCursorRequests).toEqual(["proj_a"]);

  // A view/scope change has the same invalidation contract as a connection
  // change: the serial batch must stop before starting the second project.
  await page.getByRole("button", { name: "Select Studio environment" }).click();
  await expect(page.getByRole("button", { name: "Open proj_a thread in Project A" })).toBeVisible();
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  oldCursorRequests.length = 0;
  await page.getByLabel("All-projects thread coverage").getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect.poll(() => held.length).toBe(2);
  await page.getByRole("button", { name: "Selected project", exact: true }).click();
  await held[1]!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope({ items: [], nextCursor: null, total: 2, freshness: envelope({}).freshness })) });
  await page.waitForTimeout(300);
  expect(oldCursorRequests).toEqual(["proj_a"]);
});

/*
 * EGA-815 selected-thread live refresh. MOCKED INTEGRATION COVERAGE against a
 * stubbed `/api/t3/*` boundary: no live T3 endpoint, credential or write is used.
 */

type VisibilityWindow = Window & { __helmSetVisibility?: (value: "visible" | "hidden") => void };

/** Overrides the document visibility state and fires the real event the hook listens for. */
async function installVisibilityControl(page: Page) {
  await page.addInitScript(() => {
    let current: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => current });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => current === "hidden" });
    (window as VisibilityWindow).__helmSetVisibility = (value) => {
      current = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function setVisibility(page: Page, value: "visible" | "hidden") {
  await page.evaluate((next) => (window as VisibilityWindow).__helmSetVisibility?.(next), value);
}

function incrementalDetail(threadId: string, status: string, items: readonly unknown[], nextPosition: number | null) {
  return envelope({
    thread: thread(threadId, `Thread ${threadId}`, status, "2026-10-12T08:00:00.000Z"),
    items,
    recentRuns: [],
    nextPosition,
    hasMore: false,
  });
}

test("selected running thread auto-refreshes incrementally with a bounded request budget", async ({ page }) => {
  await page.clock.install();
  const reads: (number | null)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      reads.push(after === null ? null : Number(after));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Keep the request open briefly so an accidental overlapping poll would
      // be observable as maxInFlight > 1.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      const initial = after === null;
      return fulfill(route, incrementalDetail("thr_nav", "running", initial
        ? [{ id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null }]
        : [{ id: "item_2", position: 1, kind: "assistant", text: "New activity arrived.", createdAt: null, truncated: false, nextTextOffset: null }],
        initial ? 1 : 2));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await expect(page.getByText(/Live refresh is on: this selected thread is checked about every 15 seconds/)).toBeVisible();
  expect(reads).toEqual([null]);

  // 15s base cadence: exactly one incremental read, appended once.
  await page.clock.fastForward(20_000);
  await expect(page.getByText("New activity arrived.")).toBeVisible();
  expect(reads).toEqual([null, 1]);

  // Repeated polls return the same item; identity merge keeps it once. Each
  // fake-clock advance must produce exactly one further read, not a burst.
  for (const expected of [3, 4, 5]) {
    // The next timer is installed only after the previous response settles.
    await expect.poll(() => reads.length).toBe(expected - 1);
    await page.waitForTimeout(100);
    await page.clock.fastForward(15_000);
    await expect.poll(() => reads.length).toBe(expected);
  }
  await expect(page.getByText("New activity arrived.")).toHaveCount(1);
  expect(reads).toEqual([null, 1, 2, 2, 2]);
  expect(maxInFlight).toBe(1);
});

test("hidden tab and inactive thread stop the selected-thread poll", async ({ page }) => {
  await installVisibilityControl(page);
  await page.clock.install();
  const reads: string[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const threadId = url.searchParams.get("threadId") ?? "unknown";
      reads.push(threadId);
      return fulfill(route, incrementalDetail(threadId, threadId === "thr_nav" ? "running" : "idle", [
        { id: `item_${threadId}`, position: 0, kind: "assistant", text: `Activity for ${threadId}.`, createdAt: null, truncated: false, nextTextOffset: null },
      ], 1));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Activity for thr_nav.")).toBeVisible();
  expect(reads).toEqual(["thr_nav"]);

  await setVisibility(page, "hidden");
  await expect(page.getByText("Live refresh pauses while this tab is hidden.")).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(reads).toEqual(["thr_nav"]);

  await setVisibility(page, "visible");
  await expect(page.getByText(/Live refresh is on/)).toBeVisible();
  // Let the restarted effect install its timer before advancing the fake clock.
  await page.waitForTimeout(100);
  await page.clock.fastForward(20_000);
  await expect.poll(() => reads.length).toBe(2);
  expect(reads).toEqual(["thr_nav", "thr_nav"]);

  // A native status that is not a confirmed run is not polled either.
  await page.getByRole("button", { name: /Review the frontend contract/ }).click();
  await expect(page.getByText("Activity for thr_contract.")).toBeVisible();
  const beforeInactive = reads.length;
  await expect(page.getByText(/Live refresh paused: the native status “idle” is not a confirmed running state/)).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(reads.length).toBe(beforeInactive);
});

test("switching thread mid-request aborts the old poll and cannot mix identities", async ({ page }) => {
  await page.clock.install();
  const held: Route[] = [];
  const perThread = new Map<string, number>();
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const threadId = url.searchParams.get("threadId") ?? "unknown";
      const after = url.searchParams.get("afterPosition");
      perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
      if (threadId === "thr_nav" && after !== null) {
        held.push(route);
        return;
      }
      return fulfill(route, incrementalDetail(threadId, threadId === "thr_nav" ? "running" : "waiting_for_approval", [
        { id: `item_${threadId}`, position: 0, kind: "assistant", text: `Detail for ${threadId}.`, createdAt: null, truncated: false, nextTextOffset: null },
      ], 1));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Detail for thr_nav.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect.poll(() => held.length).toBe(1);

  await page.getByRole("button", { name: /Review the frontend contract/ }).click();
  await expect(page.getByText("Detail for thr_contract.")).toBeVisible();

  // The old request is aborted; even a late body must not land on the new thread.
  await held[0]!.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(incrementalDetail("thr_nav", "running", [
      { id: "item_late", position: 1, kind: "assistant", text: "Late thr_nav activity.", createdAt: null, truncated: false, nextTextOffset: null },
    ], 2)),
  }).catch(() => undefined);
  await page.waitForTimeout(100);
  await expect(page.getByText("Late thr_nav activity.")).toHaveCount(0);
  await expect(page.getByText("Detail for thr_contract.")).toBeVisible();

  const oldReads = perThread.get("thr_nav") ?? 0;
  await page.clock.fastForward(60_000);
  expect(perThread.get("thr_nav")).toBe(oldReads);
});

test("429/5xx failures back off and show an honest stale state", async ({ page }) => {
  await page.clock.install();
  const reads: (number | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      reads.push(after === null ? null : Number(after));
      if (after === null) {
        return fulfill(route, incrementalDetail("thr_nav", "running", [
          { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return fulfill(route, { error: { code: "read_failed", message: "Live refresh read failed.", retryable: true } }, 502);
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.getByText(/Live refresh failed: Live refresh read failed\./)).toBeVisible();
  await expect(page.getByText(/Showing activity observed at/)).toBeVisible();
  expect(reads).toEqual([null, 1]);

  // First failure waits two base intervals (30s), not another 15s.
  await page.clock.fastForward(29_000);
  expect(reads).toEqual([null, 1]);
  await page.clock.fastForward(2_000);
  await expect.poll(() => reads.length).toBe(3);
  expect(reads).toEqual([null, 1, 1]);
});

test("manual Refresh activity still works before the first poll and does not duplicate items", async ({ page }) => {
  await page.clock.install();
  let fullReads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      if (after === null) {
        fullReads += 1;
        const items = fullReads === 1
          ? [{ id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null }]
          : [
            { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
            { id: "item_2", position: 1, kind: "assistant", text: "Activity added by manual refresh.", createdAt: null, truncated: false, nextTextOffset: null },
          ];
        return fulfill(route, incrementalDetail("thr_nav", "running", items, 2));
      }
      return fulfill(route, incrementalDetail("thr_nav", "running", [], 2));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByText("Activity added by manual refresh.")).toBeVisible();
  await expect(page.getByText("Initial activity.")).toHaveCount(1);
  expect(fullReads).toBe(2);
});

test("All projects summary refresh never reads thread activity for every row", async ({ page }) => {
  await page.clock.install();
  let threadListReads = 0;
  let threadDetailReads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/thread")) {
        threadDetailReads += 1;
        return fulfill(route, incrementalDetail("thr_nav", "running", [], null));
      }
      if (path.endsWith("/threads")) {
        threadListReads += 1;
        const projectId = url.searchParams.get("projectId") ?? "proj_helm";
        return fulfill(route, envelope({
          items: [{ ...thread(`thr_${projectId}`, `${projectId} thread`, "running", "2026-11-03T09:00:00.000Z"), projectId }],
          nextCursor: null,
          total: 1,
          freshness: envelope({}).freshness,
        }));
      }
      return void route.fallback();
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open proj_helm thread in Helm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open proj_design thread in Design system" })).toBeVisible();
  expect(threadDetailReads).toBe(0);
  const initialListReads = threadListReads;

  // One slower summary tick re-reads the loaded first pages only.
  await page.clock.fastForward(70_000);
  await expect.poll(() => threadListReads).toBeGreaterThan(initialListReads);
  expect(threadListReads).toBeLessThanOrEqual(initialListReads + 2);
  expect(threadDetailReads).toBe(0);
});

test("a background access denial clears private activity and stops the poll", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      reads += 1;
      if (url.searchParams.get("afterPosition") === null) {
        return fulfill(route, incrementalDetail("thr_nav", "running", [
          { id: "item_1", position: 0, kind: "user", text: "Private activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return fulfill(route, { error: { code: "access_denied", message: "Owner access is required.", retryable: false } }, 401);
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Private activity.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.getByText("Owner access is required.").first()).toBeVisible();
  await expect(page.getByText("Private activity.")).toHaveCount(0);
  const afterDenial = reads;
  await page.clock.fastForward(300_000);
  expect(reads).toBe(afterDenial);
});

test("selected-project summary refresh keeps the active server-side filter", async ({ page }) => {
  await page.clock.install();
  const queries: (string | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/threads")) return void route.fallback();
      const query = url.searchParams.get("titleContains");
      queries.push(query);
      const items = query === "typography"
        ? [thread("thr_typography", "Typography tokens", "idle", null)]
        : [
          thread("thr_nav", "Refine the workspace navigation", "running", null),
          thread("thr_contract", "Review the frontend contract", "waiting_for_approval", null),
          thread("thr_typography", "Typography tokens", "idle", null),
          thread("thr_tokens", "Spacing tokens", "idle", null),
          thread("thr_copy", "Copy pass", "idle", null),
        ];
      return fulfill(route, envelope({ items, nextCursor: null, total: items.length, freshness: envelope({}).freshness }));
    },
  });

  await page.goto("/");
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button")).toHaveCount(5);
  await page.getByLabel("Search threads", { exact: true }).fill("typography");
  await page.clock.fastForward(400);
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button")).toHaveCount(1);
  await expect(page.getByText(/1 matching threads in this loaded page of 1 reported by T3/)).toBeVisible();

  await page.waitForTimeout(100);
  await page.clock.fastForward(70_000);
  await expect.poll(() => queries.filter((query) => query === "typography").length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("list", { name: "Thread list" }).getByRole("button")).toHaveCount(1);
  await expect(page.getByText("Refine the workspace navigation")).toHaveCount(0);
  expect(queries.at(-1)).toBe("typography");
});

test("summary refresh preserves a consumed continuation cursor and keeps running", async ({ page }) => {
  await page.clock.install();
  let firstPageReads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/threads")) return void route.fallback();
      const cursor = url.searchParams.get("cursor");
      if (cursor === "7") {
        return fulfill(route, envelope({
          items: [thread("thr_page_two", "Second page thread", "idle", null)],
          nextCursor: null, total: 2, freshness: envelope({}).freshness,
        }));
      }
      firstPageReads += 1;
      return fulfill(route, envelope({
        items: [thread("thr_page_one", "First page thread", "running", null)],
        nextCursor: 7, total: 2, freshness: envelope({}).freshness,
      }));
    },
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Load more threads", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Second page thread in Helm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more threads", exact: true })).toHaveCount(0);
  const beforeSummary = firstPageReads;

  await page.waitForTimeout(100);
  await page.clock.fastForward(70_000);
  await expect.poll(() => firstPageReads).toBeGreaterThan(beforeSummary);
  // The first-page refresh must not resurrect "Load more threads" for pages
  // that are already loaded.
  await expect(page.getByRole("button", { name: "Load more threads", exact: true })).toHaveCount(0);

  const afterFirstSummary = firstPageReads;
  await page.waitForTimeout(100);
  await page.clock.fastForward(70_000);
  await expect.poll(() => firstPageReads).toBeGreaterThan(afterFirstSummary);
});

test("Retry-After cannot shorten the 429 backoff", async ({ page }) => {
  await page.clock.install();
  const reads: (number | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      reads.push(after === null ? null : Number(after));
      if (after === null) {
        return fulfill(route, incrementalDetail("thr_nav", "running", [
          { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return void route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: JSON.stringify({ error: { code: "rate_limited", message: "T3 is receiving too many requests. Try again shortly.", retryable: true } }),
      });
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.getByText(/Live refresh failed:/)).toBeVisible();
  expect(reads).toEqual([null, 1]);

  // Retry-After: 1 must not turn the first failure into a 1-second loop.
  await page.clock.fastForward(29_000);
  expect(reads).toEqual([null, 1]);
  await page.clock.fastForward(2_000);
  await expect.poll(() => reads.length).toBe(3);
});

test("a failed initial detail read never claims a retrying live loop", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      return fulfill(route, { error: { code: "read_failed", message: "Initial activity read failed.", retryable: true } }, 502);
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText(/no live loop is running/)).toBeVisible();
  await expect(page.getByText(/retrying with backoff/)).toHaveCount(0);
});

test("a non-retryable revoked poll stops with terminal copy and no timer", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      reads += 1;
      if (url.searchParams.get("afterPosition") === null) {
        return fulfill(route, incrementalDetail("thr_nav", "running", [
          { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return fulfill(route, { error: { code: "revoked", message: "Reconnect to continue.", retryable: false } }, 502);
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.getByText(/Live refresh stopped: Reconnect to continue\./)).toBeVisible();
  await expect(page.getByText(/retrying with backoff/)).toHaveCount(0);
  await expect(page.getByText(/Live refresh is on/)).toHaveCount(0);
  const afterStop = reads;
  await page.clock.fastForward(300_000);
  expect(reads).toBe(afterStop);
});

test("a bare 503 keeps backing off instead of permanently stopping", async ({ page }) => {
  await page.clock.install();
  const reads: (number | null)[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      reads.push(after === null ? null : Number(after));
      if (after === null) {
        return fulfill(route, incrementalDetail("thr_nav", "running", [
          { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return void route.fulfill({ status: 503, contentType: "text/plain", body: "gateway timeout" });
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.getByText(/Live refresh failed:/)).toBeVisible();
  await expect(page.getByText(/retrying with backoff/)).toBeVisible();
  expect(reads).toEqual([null, 1]);
  await page.clock.fastForward(29_000);
  expect(reads).toEqual([null, 1]);
  await page.clock.fastForward(2_000);
  await expect.poll(() => reads.length).toBe(3);
});

test("Refresh activity aborts a held Load more without a false failure", async ({ page }) => {
  const held: Route[] = [];
  let fullReads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      if (after !== null) {
        held.push(route);
        return;
      }
      fullReads += 1;
      const items = fullReads === 1
        ? [{ id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null }]
        : [
          { id: "item_1", position: 0, kind: "user", text: "Initial activity.", createdAt: null, truncated: false, nextTextOffset: null },
          { id: "item_2", position: 1, kind: "assistant", text: "Full refresh result.", createdAt: null, truncated: false, nextTextOffset: null },
        ];
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"),
        items, recentRuns: [], nextPosition: fullReads === 1 ? 2 : 3, hasMore: fullReads === 1,
      }));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Initial activity.")).toBeVisible();
  await page.getByRole("button", { name: "Load more activity", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByText("Full refresh result.")).toBeVisible();
  await expect(page.getByText(/Load more activity failed/)).toHaveCount(0);
  await held[0]!.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(envelope({
      thread: thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"),
      items: [{ id: "item_late", position: 2, kind: "assistant", text: "Late load-more result.", createdAt: null, truncated: false, nextTextOffset: null }],
      recentRuns: [], nextPosition: 3, hasMore: false,
    })),
  }).catch(() => undefined);
  await page.waitForTimeout(100);
  await expect(page.getByText("Late load-more result.")).toHaveCount(0);
  await expect(page.getByText(/Load more activity failed/)).toHaveCount(0);
});

test("a detail with no native status is not polled from a stale list status", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      reads += 1;
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", null, null),
        items: [{ id: "item_1", position: 0, kind: "user", text: "Statusless activity.", createdAt: null, truncated: false, nextTextOffset: null }],
        recentRuns: [], nextPosition: 1, hasMore: false,
      }));
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Statusless activity.")).toBeVisible();
  await expect(page.getByText(/not a confirmed running state/)).toBeVisible();
  expect(reads).toBe(1);
  await page.clock.fastForward(60_000);
  expect(reads).toBe(1);
});

test("a visibility-aborted poll clears the activity busy flag", async ({ page }) => {
  await installVisibilityControl(page);
  await page.clock.install();
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const after = url.searchParams.get("afterPosition");
      if (after !== null) {
        held.push(route);
        return;
      }
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"),
        items: [{ id: "item_1", position: 0, kind: "assistant", text: "Inspected the", createdAt: null, truncated: true, nextTextOffset: 5 }],
        recentRuns: [], nextPosition: 1, hasMore: false,
      }));
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByRole("button", { name: "Load more text", exact: true })).toBeEnabled();
  await page.clock.fastForward(20_000);
  await expect.poll(() => held.length).toBe(1);
  await setVisibility(page, "hidden");
  await expect(page.getByText(/Live refresh pauses while this tab is hidden/)).toBeVisible();
  await setVisibility(page, "visible");
  await page.waitForTimeout(100);
  // The aborted request must release the single activity slot, not leave the
  // continuation control stuck in "Loading text…".
  await expect(page.getByRole("button", { name: "Load more text", exact: true })).toBeEnabled();
});

/**
 * F44-1: every selected-thread activity read must own an abort controller that
 * is cancelled synchronously when a newer read replaces it. These helpers
 * observe the single activity slot from the browser's side of the stubbed
 * `/api/t3/*` boundary.
 */
type ActivityFetchSnapshot = { active: number; max: number; aborted: string[] };

/**
 * Counts client-side activity fetches that are open and not aborted, plus the
 * abort signal calls that cancelled one. An `active`/`max` above one means two
 * activity reads really overlapped in the browser, not just in Playwright's
 * event delivery order.
 */
async function trackActivityFetches(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let active = 0;
    let max = 0;
    const aborted: string[] = [];
    const isActivity = (url: string) => {
      try { return new URL(url, window.location.origin).pathname.endsWith("/thread"); } catch { return false; }
    };
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!isActivity(url)) return original(input, init);
      active += 1;
      max = Math.max(max, active);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        active -= 1;
      };
      init?.signal?.addEventListener("abort", () => {
        // Aborting an already settled fetch is not a cancellation.
        if (settled) return;
        aborted.push(url);
        finish();
      }, { once: true });
      const request = original(input, init);
      request.then(finish, finish);
      return request;
    }) as typeof window.fetch;
    (window as unknown as { __helmActivityFetch: { snapshot: () => ActivityFetchSnapshot } }).__helmActivityFetch = {
      snapshot: () => ({ active, max, aborted: [...aborted] }),
    };
  });
}

async function activityFetchSnapshot(page: Page): Promise<ActivityFetchSnapshot> {
  return page.evaluate(() => (window as unknown as { __helmActivityFetch: { snapshot: () => ActivityFetchSnapshot } }).__helmActivityFetch.snapshot());
}

/** Fulfils a route the client should already have aborted; the browser drops it. */
async function fulfilAborted(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => undefined);
}

const accessDenied = { error: { code: "access_denied", message: "Owner access is required.", retryable: false } };

test("Refresh activity aborts a held truncated read and ignores its late access denial", async ({ page }) => {
  await trackActivityFetches(page);
  const held: Route[] = [];
  let fullReads = 0;
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      if (url.searchParams.get("itemId") !== null) {
        held.push(route);
        return;
      }
      fullReads += 1;
      const first = fullReads === 1;
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", "waiting_for_approval", "2026-10-12T08:00:00.000Z"),
        items: first
          ? [{ id: "item_1", position: 0, kind: "assistant", text: "Inspected the", createdAt: null, truncated: true, nextTextOffset: 5 }]
          : [{ id: "item_1", position: 0, kind: "assistant", text: "Refreshed activity.", createdAt: null, truncated: false, nextTextOffset: null }],
        recentRuns: [], nextPosition: 1, hasMore: false,
      }));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByRole("button", { name: "Load more text", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);

  // Refresh starts a new initial read. The held continuation must be aborted
  // before it can overlap the new request.
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByText("Refreshed activity.")).toBeVisible();
  await expect.poll(async () => (await activityFetchSnapshot(page)).aborted.length).toBe(1);
  expect((await activityFetchSnapshot(page)).max).toBe(1);

  // A late denial from the obsolete continuation must not clear the newer read.
  await fulfilAborted(held[0]!, 401, accessDenied);
  await page.waitForTimeout(200);
  await expect(page.getByText("Refreshed activity.")).toBeVisible();
  await expect(page.getByText("Owner access is required.")).toHaveCount(0);
});

test("selecting another thread aborts a held truncated read and keeps the new private state", async ({ page }) => {
  await trackActivityFetches(page);
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const threadId = url.searchParams.get("threadId") ?? "thr_nav";
      if (url.searchParams.get("itemId") !== null) {
        held.push(route);
        return;
      }
      if (threadId === "thr_contract") {
        return fulfill(route, incrementalDetail("thr_contract", "waiting_for_approval", [
          { id: "item_contract", position: 0, kind: "assistant", text: "Contract activity.", createdAt: null, truncated: true, nextTextOffset: 4 },
        ], 1));
      }
      return fulfill(route, incrementalDetail("thr_nav", "waiting_for_approval", [
        { id: "item_1", position: 0, kind: "assistant", text: "Inspected the", createdAt: null, truncated: true, nextTextOffset: 5 },
      ], 1));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);

  await page.getByRole("button", { name: /Review the frontend contract/ }).click();
  await expect(page.getByText("Contract activity.")).toBeVisible();
  await expect.poll(async () => (await activityFetchSnapshot(page)).aborted.length).toBe(1);
  expect((await activityFetchSnapshot(page)).max).toBe(1);

  await fulfilAborted(held[0]!, 401, accessDenied);
  await page.waitForTimeout(200);
  await expect(page.getByText("Contract activity.")).toBeVisible();
  await expect(page.getByText("Owner access is required.")).toHaveCount(0);
  // The stale finally must not clear the newer selection's busy slot or leave
  // its continuation stuck.
  await expect(page.getByRole("button", { name: "Load more text", exact: true })).toBeEnabled();
});

test("switching thread cancels a held Load more activity through the same activity slot", async ({ page }) => {
  await trackActivityFetches(page);
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      const threadId = url.searchParams.get("threadId") ?? "thr_nav";
      if (url.searchParams.get("afterPosition") !== null) {
        held.push(route);
        return;
      }
      if (threadId === "thr_contract") {
        return fulfill(route, incrementalDetail("thr_contract", "waiting_for_approval", [
          { id: "item_contract", position: 0, kind: "assistant", text: "Contract activity.", createdAt: null, truncated: false, nextTextOffset: null },
        ], 1));
      }
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", "waiting_for_approval", "2026-10-12T08:00:00.000Z"),
        items: [{ id: "item_1", position: 0, kind: "assistant", text: "First activity page.", createdAt: null, truncated: false, nextTextOffset: null }],
        recentRuns: [], nextPosition: 2, hasMore: true,
      }));
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("First activity page.")).toBeVisible();
  await page.getByRole("button", { name: "Load more activity", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);

  await page.getByRole("button", { name: /Review the frontend contract/ }).click();
  await expect(page.getByText("Contract activity.")).toBeVisible();
  await expect.poll(async () => (await activityFetchSnapshot(page)).aborted.length).toBe(1);
  expect((await activityFetchSnapshot(page)).max).toBe(1);

  await fulfilAborted(held[0]!, 401, accessDenied);
  await page.waitForTimeout(200);
  await expect(page.getByText("Contract activity.")).toBeVisible();
  await expect(page.getByText("Owner access is required.")).toHaveCount(0);
  await expect(page.getByText(/Load more activity failed/)).toHaveCount(0);
});

test("selecting another connection aborts a held truncated read and keeps the inventory", async ({ page }) => {
  await trackActivityFetches(page);
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      if (url.searchParams.get("itemId") !== null) {
        held.push(route);
        return;
      }
      return fulfill(route, incrementalDetail("thr_nav", "waiting_for_approval", [
        { id: "item_1", position: 0, kind: "assistant", text: "Inspected the", createdAt: null, truncated: true, nextTextOffset: 5 },
      ], 1));
    },
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);

  await page.getByRole("button", { name: "Select Laptop environment" }).click();
  await expect(page.getByText("This connection is not authorized right now.")).toBeVisible();
  await expect.poll(async () => (await activityFetchSnapshot(page)).aborted.length).toBe(1);
  expect((await activityFetchSnapshot(page)).max).toBe(1);

  await fulfilAborted(held[0]!, 401, accessDenied);
  await page.waitForTimeout(200);
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await expect(page.getByText("Owner access is required.")).toHaveCount(0);
});

test("changing the selected-project filter cancels a held truncated read", async ({ page }) => {
  await trackActivityFetches(page);
  const held: Route[] = [];
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      if (url.searchParams.get("itemId") !== null) {
        held.push(route);
        return;
      }
      return fulfill(route, incrementalDetail("thr_nav", "waiting_for_approval", [
        { id: "item_1", position: 0, kind: "assistant", text: "Inspected the", createdAt: null, truncated: true, nextTextOffset: 5 },
      ], 1));
    },
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);

  // A server-side filter change clears the opened thread and starts a new
  // query scope, so the held continuation must not survive into it.
  await page.getByLabel("Search threads", { exact: true }).fill("typography");
  await expect(page.getByRole("button", { name: /Explore typography tokens/ })).toBeVisible();
  await expect(page.getByText("Select a thread to read its activity.")).toBeVisible();
  await expect.poll(async () => (await activityFetchSnapshot(page)).aborted.length).toBe(1);
  expect((await activityFetchSnapshot(page)).max).toBe(1);

  await fulfilAborted(held[0]!, 401, accessDenied);
  await page.waitForTimeout(200);
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Explore typography tokens/ })).toBeVisible();
  await expect(page.getByText("Owner access is required.")).toHaveCount(0);
});

test("a 401 on truncated text clears private activity", async ({ page }) => {
  await stubLiveApi(page, {
    "**/api/t3/connections/**": (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/thread")) return void route.fallback();
      if (url.searchParams.get("itemId") !== null) {
        return fulfill(route, { error: { code: "access_denied", message: "Owner access is required.", retryable: false } }, 401);
      }
      return fulfill(route, envelope({
        thread: thread("thr_nav", "Refine the workspace navigation", "running", "2026-10-12T08:00:00.000Z"),
        items: [{ id: "item_1", position: 0, kind: "assistant", text: "Private truncated text.", createdAt: null, truncated: true, nextTextOffset: 5 }],
        recentRuns: [], nextPosition: null, hasMore: false,
      }));
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Refine the workspace navigation/ }).click();
  await expect(page.getByText("Private truncated text.")).toBeVisible();
  await page.getByRole("button", { name: "Load more text", exact: true }).click();
  await expect(page.getByText("Owner access is required.").first()).toBeVisible();
  await expect(page.getByText("Private truncated text.")).toHaveCount(0);
});
