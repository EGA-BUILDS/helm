import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Confirmation-reset regressions, DOM level (EGA-765 v0.2 D1).
 *
 * The pure decision helper (`resolveConfirmClick`) is proven in the vitest
 * suite; these tests prove the MOUNTED component honours it in a real
 * browser, without a remount hiding the defect. The invariant under test: a
 * confirmation armed for one selection can never fire against another, and an
 * outcome produced for one selection is never displayed under another.
 *
 * These files are named `interrupt-reset.*` so they never collide with the
 * lead-owned `interrupt.*` harness.
 */

const RUN_1 = "run:thread:ordinal:1";
const RUN_2 = "run:thread:ordinal:2";
const THREAD_ID = "mcp:00000000-0000-4000-8000-000000000001";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "requested",
    reason: null,
    detail: "T3 accepted the interrupt request.",
    threadId: THREAD_ID,
    runId: RUN_1,
    observedAt: "2026-10-12T09:05:00.000Z",
    t3Reference: `T3 thread ${THREAD_ID}`,
    ...overrides,
  };
}

type InterruptBody = { connectionId?: string; projectId?: string; threadId?: string; runId?: string };

async function stubInterrupt(page: Page, respond: () => unknown = () => envelope()) {
  const posts: InterruptBody[] = [];
  await page.route("**/api/t3/threads/interrupt", async (route: Route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}") as InterruptBody);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(respond()) });
  });
  return posts;
}

async function boot(page: Page) {
  await page.goto("/interrupt-reset.html");
  await expect(page.getByTestId("selected-run")).toHaveText(RUN_1);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
}

test("an armed confirmation clears when the selected run changes, and re-arms for the new run", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByText(`Confirm interrupting run ${RUN_1}?`, { exact: false })).toBeVisible();

  await page.getByLabel("Selected run").selectOption("1");

  // The confirming button disappears with the stale selection: the panel must
  // never survive the switch, let alone repaint with the new run id.
  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toHaveCount(0);
  await expect(page.getByText(`Confirm interrupting run`, { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(posts, "a selection change must never issue an interrupt").toHaveLength(0);
  await expect(page.getByTestId("result-count")).toHaveText("results:0");

  // Re-arming belongs to run 2 and carries run 2's identity in the copy.
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByText(`Confirm interrupting run ${RUN_2}?`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Confirm interrupt", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("results:1");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.runId).toBe(RUN_2);
});

test("an armed confirmation clears when the last-observed run status refreshes", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  // For run:ordinal:1, a waiting status refresh (runStatus prop change).
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toBeVisible();

  await page.getByLabel("Mark waiting").check();

  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
  await expect(page.getByTestId("result-count")).toHaveText("results:0");
});

test("a pending response produced for run one is never rendered under run two", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posts: InterruptBody[] = [];
  await page.route("**/api/t3/threads/interrupt", async (route: Route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}") as InterruptBody);
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope()) });
  });
  await boot(page);

  // Confirm against run 1; the response is held in flight inside the stub.
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm interrupt", exact: true }).click();
  await expect(page.getByText("Requesting interrupt…", { exact: false })).toBeVisible();

  // The owner switches runs while the request is still pending.
  await page.getByLabel("Selected run").selectOption("1");
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await expect(page.getByText("Requesting interrupt…", { exact: false })).toHaveCount(0);

  release();
  await expect(page.getByTestId("result-count")).toHaveText("results:1");

  // Run A's outcome may reach the parent, but the run-2 view must never
  // repaint as run A's result.
  await expect(page.getByText("Interrupt requested", { exact: false })).toHaveCount(0);
  expect(posts, "the in-flight request must not be duplicated or retried").toHaveLength(1);

  // Ran two's outcome section is clean: nothing rendered and nothing posted.
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(1);
});
