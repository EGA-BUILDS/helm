import { expect, test } from "@playwright/test";

test("signed-out visitors see private sign-in and no owner content", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Helm" })).toBeVisible();
  await expect(page.getByText("Private owner dashboard")).toHaveCount(0);
  await expect(page.getByText("Owner access verified by Convex.")).toHaveCount(0);
});
