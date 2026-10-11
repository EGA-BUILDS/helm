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
test("local endpoint validation never grants access or sends a T3 request", async ({ page }) => {
  const unexpected: string[] = [];
  page.on("request", (request) => { if (!request.url().startsWith("http://127.0.0.1:4173/")) unexpected.push(request.url()); });
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://example.invalid/oauth");
  await expect(page.getByText("The native T3 MCP URL must end in /mcp.")).toBeVisible();
  await page.getByLabel("T3 MCP endpoint", { exact: true }).fill("https://example.invalid/mcp");
  await expect(page.getByText("URL format looks valid. Reachability has not been checked.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect T3", exact: true })).toBeDisabled();
  expect(unexpected).toEqual([]);
});
test("fixture selection previews OAuth states and resets to unavailable", async ({ page }) => {
  for (const [value, heading] of [["pending", "Waiting for T3 approval"], ["denied", "Sign-in was denied"], ["expired", "T3 sign-in expired"], ["failed", "T3 connection failed"]]) {
    await scenario(page, value);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Development fixture preview — no live T3 connection", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  }
  await scenario(page, "off");
  await expect(page.getByText("T3 backend integration is not available yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your T3 environment", exact: true })).toBeVisible();
});
test("projects and threads support local search, selection, empty results, and copying", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await scenario(page, "connected");
  await page.getByLabel("Search projects", { exact: true }).fill("design");
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button")).toHaveCount(1);
  await expect(page.getByText("No real agent has run.", { exact: false })).toBeVisible();
  await page.getByLabel("Search projects", { exact: true }).fill("no match");
  await expect(page.getByText("No matching projects. Try a different search.")).toBeVisible();
  await page.getByLabel("Search projects", { exact: true }).fill("");
  await page.getByRole("list", { name: "Project list", exact: true }).getByRole("button", { name: /Design system/ }).click();
  await expect(page.getByRole("region", { name: "Projects" }).getByRole("definition").filter({ hasText: "/sample/design-system" })).toBeVisible();
  await page.getByLabel("Project", { exact: true }).selectOption("sample-design");
  await expect(page.getByRole("list", { name: "Thread list", exact: true }).getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "Copy T3 reference", exact: true }).click();
  await expect(page.getByText("T3 reference copied.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("t3-thread://v1/sample-thread-type");
  await page.getByLabel("Search threads", { exact: true }).fill("unmatched");
  await expect(page.getByText("No matching threads. Clear the search or change the project.")).toBeVisible();
});
test("environment selection scopes reads and marks disconnected or expired access", async ({ page }) => {
  await scenario(page, "connected");
  await expect(page.getByRole("button", { name: "Select Studio environment" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("list", { name: "Project list", exact: true }).getByRole("button")).toHaveCount(2);
  await page.getByRole("button", { name: "Select Laptop environment" }).click();
  await expect(page.getByRole("button", { name: "Select Laptop environment" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Select a connected environment to browse its projects.")).toBeVisible();
  await expect(page.getByText("Sample · Expired", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select Studio backup environment" }).click();
  await expect(page.getByText("Sample · Disconnected", { exact: true })).toBeVisible();
  await expect(page.getByText("Select a connected environment to browse its threads.")).toBeVisible();
});
test("all remote actions stay disabled in a connected preview", async ({ page }) => {
  await scenario(page, "connected");
  for (const name of ["Reconnect", "Disconnect"]) {
    const buttons = page.getByRole("button", { name, exact: true });
    await expect(buttons).toHaveCount(name === "Reconnect" ? 4 : 4);
    for (let index = 0; index < await buttons.count(); index++) await expect(buttons.nth(index)).toBeDisabled();
  }
  for (const name of ["Start thread", "Send follow-up", "Interrupt thread"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add environment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Register project", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Follow-up message", { exact: true })).toBeDisabled();
});
test("read states show missing data, empty pages, loading and provider failure", async ({ page }) => {
  for (const [value, text] of [["missing-environments", "No environments returned"], ["empty-projects", "No projects returned"], ["empty-threads", "No threads returned"], ["provider-unavailable", "Provider catalog is unavailable in this sample."], ["loading", "Loading projects…"], ["stale", "Stale — refresh required"]]) {
    await scenario(page, value);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  }
});
for (const width of [360, 768, 1440]) test(`navigation is keyboard accessible and layout fits ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await scenario(page, "connected");
  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(navigation.getByRole("link")).toHaveCount(6);
  const projects = navigation.getByRole("link", { name: "Projects", exact: true });
  await projects.focus();
  await page.keyboard.press("Enter");
  await expect(projects).toHaveAttribute("aria-current", "location");
  await expect(page.getByRole("heading", { name: "A home for every project" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `test-results/helm-dashboard-${width}.png`, fullPage: true });
  await page.keyboard.press("Control+Home");
  await page.getByRole("link", { name: "Skip to dashboard content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#overview")).toBeFocused();
});
test("dark appearance remains readable and fits a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await scenario(page, "connected");
  await expect(page.getByRole("heading", { name: "Everything in view. You at the helm." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
