import { expect, test, type Page, type Route } from "@playwright/test";

const CONNECTION_ID = "c-1";
const PROJECT_ID = "t3-proj-1";
const THREAD_ID = "mcp:00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "issue-uuid-1";

function mapping() {
  return {
    mappingId: "map-1",
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearProjectName: "Helm",
    linearTeamId: "team-eng",
    linearTeamKey: "ENG",
    linearTeamName: "Engineering",
    t3ConnectionId: CONNECTION_ID,
    t3EnvironmentId: "env-1",
    t3ProjectId: PROJECT_ID,
    t3ProjectTitle: "Helm native",
    worktreeBaseRef: "refs/heads/main",
    targetBranch: "main",
    startedStateId: "s-progress",
    startedStateName: "In Progress",
    enabled: true,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    identifier: "EGA-763",
    title: "Manual link issue",
    url: "https://linear.app/issue/EGA-763",
    priority: 2,
    priorityLabel: "High",
    state: { id: "s1", name: "In Progress", type: "started" },
    team: { id: "team-eng", key: "ENG", name: "Engineering" },
    assignee: null,
    description: "desc",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

function issuesPage() {
  return {
    items: [issue(), issue({ id: "issue-2", identifier: "EGA-764", title: "Second issue" })],
    nextCursor: null,
    total: null,
    filtersEcho: {
      projectId: "proj-1",
      includeCompleted: false,
      stateType: null,
      priority: null,
      assigneeId: null,
      text: null,
      textScope: null,
      limit: 25,
    },
    freshness: { source: "linear", observedAt: "2026-10-12T00:00:00.000Z", stale: false },
    errors: [],
  };
}

function association(overrides: Record<string, unknown> = {}) {
  return {
    associationId: "assoc-1",
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: ISSUE_ID,
    linearIssueIdentifier: "EGA-763",
    t3ConnectionId: CONNECTION_ID,
    t3EnvironmentId: "env-1",
    t3ProjectId: PROJECT_ID,
    t3ThreadId: THREAD_ID,
    attemptId: "",
    correlationKey: "",
    unlinkedAt: 0,
    createdAt: 1700000000000,
    note: "manual link",
    state: "linked",
    provenance: "manual",
    ...overrides,
  };
}

async function stubMappings(page: Page) {
  await page.route("**/api/linear/mappings", async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mappings: [mapping()] }) });
  });
}

async function stubIssues(page: Page) {
  await page.route("**/api/linear/issues*", async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(issuesPage()) });
  });
}

async function stubReadAssociation(page: Page, value: ReturnType<typeof association> | null) {
  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ association: value }) });
  });
}

test("link a thread to a real issue and assert the association appears", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);

  const linkPosts: Array<Record<string, unknown>> = [];
  let linked = false;
  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    const value = linked ? association() : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ association: value }) });
  });
  await page.route("**/api/t3/manual-link/link", async (route: Route) => {
    linkPosts.push(JSON.parse(route.request().postData() ?? "{}"));
    linked = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ associationId: "assoc-1", created: true }) });
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  await page.getByRole("radio").first().click();
  await expect(page.getByText("Selected: EGA-763")).toBeVisible();
  await page.getByRole("button", { name: "Link thread to issue" }).click();
  await expect(page.getByText(/Linked \(created true\)/)).toBeVisible();
  await expect(page.getByText("Linked to EGA-763")).toBeVisible();
  expect(linkPosts).toHaveLength(1);
  expect(linkPosts[0].linearIssueId).toBe(ISSUE_ID);
});

test("unlink with confirmation", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);

  const unlinkPosts: Array<Record<string, unknown>> = [];
  let linked = true;
  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    const value = linked ? association() : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ association: value }) });
  });
  await page.route("**/api/t3/manual-link/unlink", async (route: Route) => {
    unlinkPosts.push(JSON.parse(route.request().postData() ?? "{}"));
    linked = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: true, deleted: true, unlinked: true, associationId: "assoc-1" }) });
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  await expect(page.getByText("Linked to EGA-763")).toBeVisible();

  await page.getByRole("button", { name: "Unlink thread" }).click();
  await expect(page.getByRole("button", { name: "Confirm unlink" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm unlink" }).click();
  await expect(page.getByText(/Unlinked \(removed true\)/)).toBeVisible();
  expect(unlinkPosts).toHaveLength(1);
  expect(unlinkPosts[0].confirm).toBe(true);
  expect(unlinkPosts[0].expectedAssociationId).toBe("assoc-1");
});

test("reassign with confirmation", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);

  const reassignPosts: Array<Record<string, unknown>> = [];
  let assocId = "assoc-1";
  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    const value = association({ associationId: assocId, linearIssueId: assocId === "assoc-1" ? ISSUE_ID : "issue-2" });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ association: value }) });
  });
  await page.route("**/api/t3/manual-link/reassign", async (route: Route) => {
    reassignPosts.push(JSON.parse(route.request().postData() ?? "{}"));
    assocId = "assoc-2";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ associationId: "assoc-2", created: true }) });
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  await expect(page.getByText("Linked to EGA-763")).toBeVisible();

  await page.getByRole("radio").nth(1).click();
  await expect(page.getByText("Selected: EGA-764")).toBeVisible();
  await page.getByRole("button", { name: "Reassign to selected issue" }).click();
  await expect(page.getByRole("button", { name: "Confirm reassignment" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm reassignment" }).click();
  await expect(page.getByText(/Reassigned \(created true\)/)).toBeVisible();
  expect(reassignPosts).toHaveLength(1);
  expect(reassignPosts[0].confirm).toBe(true);
  expect(reassignPosts[0].expectedAssociationId).toBe("assoc-1");
});

test("no request is made to native-write or Linear status endpoints", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);
  await stubReadAssociation(page, null);

  const forbidden: string[] = [];
  await page.route("**/*", async (route: Route) => {
    const url = route.request().url();
    if (url.includes("/api/t3/threads/send") || url.includes("/api/t3/threads/interrupt") || url.includes("/api/t3/launch") || url.includes("linear.app") ) {
      forbidden.push(url);
    }
    await route.continue();
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  expect(forbidden).toHaveLength(0);
});

test("reload recovers the existing association and carries its token", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);

  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ association: association() }) });
  });

  const unlinkPosts: Array<Record<string, unknown>> = [];
  await page.route("**/api/t3/manual-link/unlink", async (route: Route) => {
    unlinkPosts.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: true, deleted: true, unlinked: true, associationId: "assoc-1" }) });
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  await expect(page.getByText("Linked to EGA-763")).toBeVisible();

  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByText("Linked to EGA-763")).toBeVisible();

  await page.getByRole("button", { name: "Unlink thread" }).click();
  await page.getByRole("button", { name: "Confirm unlink" }).click();
  await expect(unlinkPosts[0].expectedAssociationId).toBe("assoc-1");
});

test("GET failure says could not read, not not linked", async ({ page }) => {
  await stubMappings(page);
  await stubIssues(page);
  await page.route("**/api/t3/manual-link?*", async (route: Route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "backend_unavailable", message: "backend down", retryable: true } }) });
  });

  await page.goto("/manual-link.html");
  await page.waitForTimeout(500);
  await expect(page.getByText(/Could not read the current association/)).toBeVisible();
  await expect(page.getByText("No Linear issue is currently linked to this thread.")).toHaveCount(0);
});
