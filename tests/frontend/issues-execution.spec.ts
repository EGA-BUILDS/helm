import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Issue-driven execution, through the REAL mounted UI (EGA-680 → EGA-761 →
 * EGA-681). The issue browser container decides whether an execution review may
 * be armed; the review panel decides when it may launch. Every `/api/*` route is
 * stubbed, so no live Linear read and no native T3 write is performed.
 */

const THREAD = "mcp:00000000-0000-4000-8000-000000000001";

const mapping = {
  mappingId: "m-1",
  linearWorkspaceId: "ws-1",
  linearProjectId: "proj-1",
  linearProjectName: "Helm",
  linearTeamId: "team-eng",
  linearTeamKey: "ENG",
  linearTeamName: "Engineering",
  t3ConnectionId: "c-1",
  t3EnvironmentId: "env-1",
  t3ProjectId: "t3-proj-1",
  t3ProjectTitle: "Helm native",
  worktreeBaseRef: "refs/heads/main",
  targetBranch: "main",
  startedStateId: "state-started",
  startedStateName: "In Progress",
  enabled: true,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

function issueWire(id: string, identifier: string, teamId = "team-eng") {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/helm/issue/${identifier}`,
    priority: 2,
    priorityLabel: "High",
    state: { id: "s-progress", name: "In Progress", type: "started" },
    team: { id: teamId, key: "ENG", name: "Engineering" },
    assignee: null,
    description: "Do the thing.",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

const freshness = { source: "linear", observedAt: "2026-10-23T00:00:00.000Z", stale: false };

function pageWire(items: unknown[]) {
  return {
    items,
    nextCursor: null,
    total: null,
    filtersEcho: {
      projectId: "proj-1", includeCompleted: false, stateType: null,
      priority: null, assigneeId: null, text: null, textScope: null, limit: 25,
    },
    freshness,
    errors: [],
  };
}

function detailWire(issue: unknown) {
  return { issue: { ...(issue as Record<string, unknown>), acceptanceCriteria: "- [ ] Works" }, freshness, errors: [] };
}

const preflightWire = {
  linearProjectId: "proj-1",
  linearTeamId: "team-eng",
  t3ConnectionId: "c-1",
  t3EnvironmentId: "env-1",
  t3ProjectId: "t3-proj-1",
  t3ProjectTitle: "Helm native",
  worktreeBaseRef: "refs/heads/main",
  targetBranch: "main",
  startedStateId: "state-started",
  catalog: {
    providers: [
      { providerInstanceId: "openai", displayName: "OpenAI", models: [{ id: "gpt-5", label: "GPT-5" }] },
    ],
    runtimeMode: "supervised",
    freshness: { source: "backend", observedAt: "2026-10-23T00:00:00.000Z", stale: false },
  },
  catalogError: null,
  blockers: [] as string[],
};

function noneWire() {
  return { latest: null, outcome: "none", canStartNewExecution: true, blockers: [], observedLatestAttemptId: null };
}

function launchedWire(attemptId: string) {
  return {
    outcome: "launched",
    reason: null,
    detail: "T3 launch acknowledged.",
    attemptId,
    correlationKey: "key",
    threadId: THREAD,
  };
}

interface StubOptions {
  mappings?: unknown[];
  issues?: unknown[];
  detailDelays?: Record<string, number>;
  preflight?: () => unknown;
  recovery?: () => unknown;
}

interface StubApi {
  posts: string[];
  detailRequests: string[];
}

async function stubIssueExecution(page: Page, options: StubOptions = {}): Promise<StubApi> {
  const api: StubApi = { posts: [], detailRequests: [] };
  const mappings = options.mappings ?? [mapping];
  const issues = options.issues ?? [issueWire("issue-1", "EGA-680")];

  await page.route("**/api/linear/mappings", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mappings }) }),
  );

  await page.route("**/api/linear/issues**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/linear/issues") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageWire(issues)) });
    }
    const issueId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    api.detailRequests.push(issueId);
    const delay = options.detailDelays?.[issueId];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const found = (issues as Array<Record<string, unknown>>).find((entry) => entry.id === issueId);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailWire(found ?? issues[0])),
    });
  });

  await page.route("**/api/execution/preflight", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify((options.preflight ?? (() => preflightWire))()),
    }),
  );

  await page.route("**/api/t3/launch*", (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify((options.recovery ?? noneWire)()),
      });
    }
    api.posts.push(route.request().postData() ?? "");
    const sent = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(launchedWire(String(sent.attemptId ?? "attempt-unknown"))),
    });
  });

  await page.goto("/issues-execution.html");
  return api;
}

async function openReview(page: Page, index = 0) {
  await page.getByRole("button", { name: "Show detail" }).nth(index).click();
  await expect(page.getByText("Start work from this issue")).toBeVisible();
  await page.getByRole("button", { name: "Prepare execution", exact: true }).click();
  await expect(page.getByText("Review the exact task prompt")).toBeVisible();
}

async function confirmReview(page: Page) {
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("Model").selectOption("gpt-5");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByText("Reviewed — launching is a separate explicit step below")).toBeVisible();
}

test("selecting a mapped issue reaches the review, which launches nothing until the explicit control", async ({ page }) => {
  const api = await stubIssueExecution(page);
  await page.getByRole("button", { name: "Show detail" }).first().click();

  await expect(page.getByRole("button", { name: "Prepare execution", exact: true })).toBeEnabled();
  // Nothing is mounted, and nothing was sent, before the owner asks to review.
  await expect(page.getByText("Review the exact task prompt")).toHaveCount(0);
  expect(api.posts).toEqual([]);

  await page.getByRole("button", { name: "Prepare execution", exact: true }).click();
  await expect(page.getByText("Execution review")).toBeVisible();
  await expect(page.getByLabel("Provider")).toBeVisible();
  // The review is composed from the authoritative issue the owner selected.
  await expect(page.getByLabel("Exact task prompt (editable)")).toHaveValue(/EGA-680 — Issue EGA-680/);
  // Subagents default to off.
  await expect(page.getByRole("radio", { name: "No" })).toBeChecked();

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("Model").selectOption("gpt-5");
  // Review alone cannot launch.
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  expect(api.posts).toEqual([]);

  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const launch = page.getByRole("button", { name: "Launch thread", exact: true });
  await expect(launch).toBeEnabled();
  expect(api.posts).toEqual([]);

  await launch.click();
  await expect(page.getByText("Launch launched")).toBeVisible();
  expect(api.posts).toHaveLength(1);
  const sent = JSON.parse(api.posts[0]!) as Record<string, unknown>;
  expect(sent).toMatchObject({
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: "issue-1",
    linearIssueIdentifier: "EGA-680",
    providerInstanceId: "openai",
    model: "gpt-5",
    useSubagents: false,
    expectedLatestAttemptId: null,
  });
  expect(typeof sent.attemptId).toBe("string");
});

test("a second click while launching cannot produce a second request", async ({ page }) => {
  const api = await stubIssueExecution(page);
  await openReview(page);
  await confirmReview(page);
  const launch = page.getByRole("button", { name: "Launch thread", exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
  // The control is disabled for the in-flight request and the acknowledgement
  // permanently disables it; a further click cannot add a request.
  await page.getByRole("button", { name: "Launch thread", exact: true }).click({ force: true }).catch(() => {});
  await expect(page.getByText("Launch launched")).toBeVisible();
  expect(api.posts).toHaveLength(1);
});

test("switching issue mid-read drops the superseded detail and arms only the latest", async ({ page }) => {
  const api = await stubIssueExecution(page, {
    issues: [issueWire("issue-1", "EGA-680"), issueWire("issue-2", "EGA-681")],
    detailDelays: { "issue-1": 900 },
  });
  await page.getByRole("button", { name: "Show detail" }).nth(0).click();
  await page.getByRole("button", { name: "Show detail" }).nth(1).click();

  // Issue A's slow response must not overwrite the issue B the owner chose
  // after it. The selected detail shows B only.
  await expect(page.getByText("EGA-681 — Issue EGA-681").last()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("EGA-680 — Issue EGA-680")).toHaveCount(1); // list row only
  await expect(page.getByRole("button", { name: "Prepare execution", exact: true })).toBeEnabled();

  // Arming now reviews issue B, never the dropped issue A.
  await page.getByRole("button", { name: "Prepare execution", exact: true }).click();
  await expect(page.getByLabel("Exact task prompt (editable)")).toHaveValue(/EGA-681 — Issue EGA-681/);
  expect(api.detailRequests).toEqual(["issue-1", "issue-2"]);
  expect(api.posts).toEqual([]);
});

test("a preflight blocker disables launch and no request is sent", async ({ page }) => {
  const api = await stubIssueExecution(page, {
    preflight: () => ({ ...preflightWire, blockers: ["No operate connection is available."] }),
  });
  await openReview(page);
  await expect(page.getByText("Execute is disabled:")).toBeVisible();
  await expect(page.getByText("No operate connection is available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  expect(api.posts).toEqual([]);
});

test("no mapping for the issue's team blocks the review before any execution call", async ({ page }) => {
  const api = await stubIssueExecution(page, {
    mappings: [{ ...mapping, linearTeamId: "team-other" }],
  });
  await page.getByRole("button", { name: "Show detail" }).first().click();
  await expect(page.getByText(/No enabled mapping covers this issue's Linear project and team/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare execution", exact: true })).toBeDisabled();
  await expect(page.getByText("Review the exact task prompt")).toHaveCount(0);
  expect(api.posts).toEqual([]);
});
