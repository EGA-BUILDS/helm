import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Native interrupt client behaviour (EGA-765 D11) — DOM level.
 *
 * These run the REAL `InterruptControl` against a stubbed
 * `/api/t3/threads/interrupt` route. They prove the client contract only; the
 * native side is mocked by the route handler.
 *
 * They exist because the confirmation-reset was previously proven only at the
 * pure decision layer. That is not enough: the invariant is that a confirmation
 * armed for one run can never fire against another. If the reset regressed, the
 * pure helper would still pass and only a mounted component would show it.
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
    t3Reference: "T3 thread mcp:00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

type InterruptBody = { connectionId?: string; projectId?: string; threadId?: string; runId?: string; clientRequestId?: string };

/** Stubs the interrupt route and returns the collected request bodies. */
async function stubInterrupt(page: Page, respond: () => unknown = () => envelope()) {
  const posts: InterruptBody[] = [];
  await page.route("**/api/t3/threads/interrupt", async (route: Route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}") as InterruptBody);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(respond()) });
  });
  return posts;
}

async function boot(page: Page) {
  await page.goto("/interrupt.html");
  await expect(page.getByTestId("selected-run")).toHaveText(RUN_1);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
}

async function selectRun(page: Page, index: 0 | 1) {
  await page.getByLabel("Selected run").selectOption(String(index));
}

test("an armed confirmation is discarded when the selected run changes, with no request issued", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toBeVisible();

  await selectRun(page, 1);

  // The armed state must be gone: the confirmation was for run 1, and run 2 is
  // now selected. Leaving the button visible is exactly the defect that lets one
  // click interrupt a run the owner never confirmed.
  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await expect(page.getByTestId("selected-run")).toHaveText(RUN_2);

  await page.waitForTimeout(300);
  expect(posts, "changing the selection must never issue an interrupt").toHaveLength(0);
  await expect(page.getByTestId("result-count")).toHaveText("results:0");
});

test("confirming sends exactly one request for the confirmed run", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm interrupt", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("results:1");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.runId).toBe(RUN_1);
  expect(posts[0]!.threadId).toBe(THREAD_ID);
  expect(posts[0]!.connectionId).toBe("c-1");
  expect(posts[0]!.projectId).toBe("t3-proj-1");
  await expect(page.getByTestId("last-outcome")).toHaveText("requested");

  // A successful acknowledgement must not be retried.
  await page.waitForTimeout(300);
  expect(posts, "an acknowledged interrupt must not be re-sent").toHaveLength(1);
});

test("after a run change, a fresh confirmation targets the newly selected run", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  // Arm against run 1, then move away — that confirmation must be void.
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await selectRun(page, 1);
  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toHaveCount(0);

  // Re-arming now belongs to run 2, and must carry run 2's identity.
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByText(`Confirm interrupting run ${RUN_2}?`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Confirm interrupt", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("results:1");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.runId).toBe(RUN_2);
});

test("an ambiguous dispatch is reported as ambiguous and never auto-retried", async ({ page }) => {
  const posts = await stubInterrupt(page, () =>
    envelope({
      outcome: "ambiguous",
      reason: "dispatch_outcome_unknown",
      detail: "The interrupt call was sent, but its acknowledgement was not received. It may or may not have been applied.",
    }),
  );
  await boot(page);

  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm interrupt", exact: true }).click();
  await expect(page.getByTestId("result-count")).toHaveText("results:1");
  await expect(page.getByTestId("last-outcome")).toHaveText("ambiguous");

  await page.waitForTimeout(500);
  expect(posts, "an ambiguous interrupt must never be retried automatically").toHaveLength(1);
});

test("cancelling a confirmation issues no request and leaves the control ready", async ({ page }) => {
  const posts = await stubInterrupt(page);
  await boot(page);

  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(page.getByRole("button", { name: "Confirm interrupt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
});
