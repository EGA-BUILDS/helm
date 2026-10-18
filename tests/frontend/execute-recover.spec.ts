import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Attempt-lifecycle browser coverage (EGA-681 follow-up, defects A and B).
 *
 * These run the REAL `ExecutePanel` against stubbed `/api/*` routes and use
 * `page.reload()` — a full browser reload that empties module-level browser
 * storage — so they prove the panel recovers the server's attempt instead of
 * minting a fresh id, and that a settled attempt leads to a genuinely new
 * execution. No live Linear or T3 connection is involved.
 */

const THREAD = "mcp:00000000-0000-4000-8000-000000000001";

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
    freshness: { source: "backend", observedAt: "2026-10-18T00:00:00.000Z", stale: false },
  },
  catalogError: null,
  blockers: [],
};

function recoveryWire(state: string, threadId: string | null) {
  const outcome =
    state === "acknowledged" || state === "reconciled"
      ? "acknowledged"
      : state === "ambiguous"
        ? "ambiguous"
        : state === "abandoned"
          ? "abandoned"
          : "unresolved";
  return {
    latest: {
      attemptId: "attempt-server",
      state,
      threadId,
      correlationKey: "[helm:issue-1:recovery]",
      dispatchedAt: 1700000000000,
      acknowledgedAt: threadId ? 1700000000001 : null,
      matchCount: null,
    },
    outcome,
    canStartNewExecution: outcome === "acknowledged" || outcome === "abandoned",
    blockers:
      outcome === "unresolved"
        ? [
            `This issue already has an unresolved launch attempt (attempt-server, state ${state}); reconcile or abandon it before launching again.`,
          ]
        : outcome === "ambiguous"
          ? ["This launch ended ambiguous; reconcile it before launching again."]
          : [],
  };
}

function noneWire() {
  return { latest: null, outcome: "none", canStartNewExecution: true, blockers: [] };
}

function launchedWire(attemptId: string) {
  return {
    outcome: "launched",
    reason: null,
    detail: "T3 launch acknowledged.",
    attemptId,
    correlationKey: "[helm:issue-1:recovery]",
    threadId: THREAD,
  };
}

interface ExecuteApi {
  posts: string[];
  gets: number;
}

async function stubExecute(page: Page, recovery: () => unknown): Promise<ExecuteApi> {
  const api: ExecuteApi = { posts: [], gets: 0 };
  await page.route("**/api/execution/preflight", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preflightWire) }),
  );
  await page.route("**/api/t3/launch*", (route: Route) => {
    if (route.request().method() === "GET") {
      api.gets += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(recovery()),
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
  await page.goto("/execute.html");
  return api;
}

async function confirmReview(page: Page) {
  // selectOption waits for the preflight-loaded options; the recovery text
  // itself depends on the stubbed server state and is asserted per test.
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("Model").selectOption("gpt-5");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByText("Reviewed — launching is a separate explicit step below")).toBeVisible();
}

test("a first execution launches fresh, then a reload shows the recorded thread", async ({
  page,
}) => {
  let current: unknown = noneWire();
  const api = await stubExecute(page, () => current);
  await expect(page.getByText("No prior executions for this issue.")).toBeVisible();
  await confirmReview(page);
  const launch = page.getByRole("button", { name: "Launch thread", exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(page.getByText("Launch launched")).toBeVisible();
  expect(api.posts).toHaveLength(1);
  const sent = JSON.parse(api.posts[0]!) as Record<string, unknown>;
  expect(typeof sent.attemptId).toBe("string");
  // The server records the attempt; a reload recovers it instead of
  // minting a fresh id behind the unresolved-or-settled row.
  current = recoveryWire("acknowledged", THREAD);
  await page.reload();
  await expect(page.getByText("Already launched", { exact: true })).toBeVisible();
  await expect(page.getByText(`Thread ${THREAD}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  expect(api.posts).toHaveLength(1);
});

test("reload after successful launch shows the existing thread and issues no second launch", async ({
  page,
}) => {
  const api = await stubExecute(page, () => recoveryWire("acknowledged", THREAD));
  await confirmReview(page);
  // The plain launch is disabled with a reason pointing at the separately
  // confirmed new execution; the recovery fetch already happened on mount.
  const launch = page.getByRole("button", { name: "Launch thread", exact: true });
  await expect(launch).toBeDisabled();
  await expect(page.getByText("Already launched", { exact: true })).toBeVisible();
  await expect(page.getByText("start a new execution below")).toBeVisible();
  await expect(page.getByText(`Thread ${THREAD}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a new execution", exact: true })).toBeVisible();
  expect(api.posts).toEqual([]);

  // A full browser reload empties module-level browser storage; the panel
  // must recover the same server attempt and still issue no launch.
  const getsBefore = api.gets;
  await page.reload();
  await expect(page.getByText("Already launched", { exact: true })).toBeVisible();
  await expect(page.getByText(`Thread ${THREAD}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  expect(api.gets).toBeGreaterThan(getsBefore);
  expect(api.posts).toEqual([]);
});

test("a settled attempt leads to a genuinely new execution only after separate confirmation", async ({
  page,
}) => {
  const api = await stubExecute(page, () => recoveryWire("acknowledged", THREAD));
  await confirmReview(page);
  await page.getByRole("button", { name: "Start a new execution", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm new execution", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm new execution", exact: true }).click();
  const launch = page.getByRole("button", { name: "Launch thread", exact: true });
  await expect(launch).toBeEnabled();
  // The old acknowledged thread stays visible until the new launch lands.
  await expect(page.getByText("Already launched", { exact: true })).toBeVisible();
  await launch.click();
  await expect(page.getByText("Launch launched")).toBeVisible();
  expect(api.posts).toHaveLength(1);
  const sent = JSON.parse(api.posts[0]!) as Record<string, unknown>;
  // A genuinely new execution: a fresh id, never the acknowledged one.
  expect(typeof sent.attemptId).toBe("string");
  expect(sent.attemptId).not.toBe("attempt-server");
});

test("reload after lost acknowledgement shows ambiguous with no relaunch affordance", async ({
  page,
}) => {
  const api = await stubExecute(page, () => recoveryWire("ambiguous", null));
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("Model").selectOption("gpt-5");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByText("Prior attempt ambiguous")).toBeVisible();
  await expect(page.getByText("no relaunch was issued")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Retry attempt/ })).toHaveCount(0);
  expect(api.posts).toEqual([]);
  await page.reload();
  await expect(page.getByText("Prior attempt ambiguous")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  expect(api.posts).toEqual([]);
});

test("reload while dispatching adopts the server attemptId on explicit retry", async ({ page }) => {
  const api = await stubExecute(page, () => recoveryWire("dispatching", null));
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("Model").selectOption("gpt-5");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByText("Prior attempt dispatching")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch thread", exact: true })).toBeDisabled();
  const retry = page.getByRole("button", { name: "Retry attempt attempt-server", exact: true });
  await expect(retry).toBeEnabled();
  expect(api.posts).toEqual([]);
  await retry.click();
  await expect(page.getByText("Launch launched")).toBeVisible();
  expect(api.posts).toHaveLength(1);
  // The retry adopts the SERVER's attemptId so the reservation is reused.
  expect((JSON.parse(api.posts[0]!) as Record<string, unknown>).attemptId).toBe("attempt-server");
});
