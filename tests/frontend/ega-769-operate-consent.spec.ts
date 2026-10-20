import { expect, test, type Page } from "@playwright/test";

async function scenario(page: Page, value: string) {
  const select = page.getByLabel("Development fixture preview", { exact: true });
  await expect(select).toBeEnabled();
  await select.selectOption(value);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Everything in view. You at the helm." })).toBeVisible();
});

test("permission level is visible per connection", async ({ page }) => {
  await scenario(page, "connected");
  await expect(page.getByText("Read only", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Operate", { exact: true }).first()).toBeVisible();
});

test("read-only connection shows no write controls", async ({ page }) => {
  await scenario(page, "connected");
  // Select Studio (read-only) environment and a thread; no follow-up/interrupt should mount.
  await expect(page.getByLabel("Follow-up message", { exact: true })).toHaveCount(0);
});