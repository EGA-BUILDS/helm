import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * EGA-766 — the pull-request card in a real browser.
 *
 * The card is the last place a forged pull-request URL could become a
 * clickable link, so it is exercised in a real browser rather than only
 * through markup assertions:
 *
 *  - a verified pull request produces exactly one anchor, and the browser
 *    resolves it to the exact validated GitHub URL;
 *  - an unverified report produces NO anchor, so a forged URL can never be
 *    clicked;
 *  - an unavailable verification produces no anchor either;
 *  - a review line appears only when the authoritative source gave a decision.
 *
 * The harness module is served by the same Vite server the other frontend
 * specs use, so the component under test is the shipped component.
 */

// Playwright transpiles specs to CommonJS, so the repository root is resolved
// from the working directory the runner was started in.
const harnessUrl = `/@fs${resolve(process.cwd(), "src/features/t3/verifiedPullRequestHarness.tsx")}`;

const verifiedPullRequest = {
  number: 42,
  owner: "EGA-BUILDS",
  name: "helm",
  url: "https://github.com/EGA-BUILDS/helm/pull/42",
  baseBranch: "develop",
  headBranch: "feat/ega-766",
  headRepository: "EGA-BUILDS/helm",
  isDraft: false,
  mergedAt: null,
  observedAt: "2026-10-20T12:00:00.000Z",
};

async function mount(page: Page, verification: unknown): Promise<void> {
  await page.evaluate(() => {
    const container = document.createElement("div");
    container.id = "ega766";
    document.body.appendChild(container);
  });
  await page.addScriptTag({
    type: "module",
    content: [
      `import { mountVerifiedPullRequestCard } from ${JSON.stringify(harnessUrl)};`,
      `mountVerifiedPullRequestCard(document.getElementById("ega766"), ${JSON.stringify(verification)});`,
    ].join("\n"),
  });
  await expect(page.locator("#ega766 section")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Loads the existing dashboard harness, which also warms the Vite
  // dependency optimizer for React before the card module is requested.
  await page.goto("/");
});

test("a verified pull request links to the exact validated GitHub URL", async ({ page }) => {
  await mount(page, {
    status: "verified_open",
    pullRequest: verifiedPullRequest,
    review: { status: "unknown", source: "github" },
    readiness: "unknown",
  });

  const link = page.locator("#ega766 a");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "https://github.com/EGA-BUILDS/helm/pull/42");
  // The browser resolves the attribute to an absolute URL; a forged scheme or
  // host would show up here even if the attribute looked plausible.
  expect(await link.evaluate((element) => (element as HTMLAnchorElement).href))
    .toBe("https://github.com/EGA-BUILDS/helm/pull/42");
  await expect(page.locator("#ega766")).toContainText("Open pull request #42");
});

test("an unverified report produces no link at all", async ({ page }) => {
  await mount(page, {
    status: "unverified_report",
    reason: "non_github_url",
    claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
  });

  await expect(page.locator("#ega766")).toContainText("Reported pull request, not verified");
  await expect(page.locator("#ega766 a")).toHaveCount(0);
  await expect(page.locator("#ega766")).not.toContainText("evil.example.com");
  await expect(page.locator("#ega766")).not.toContainText("github.com/EGA-BUILDS/helm/pull/42");
});

test("an unavailable verification produces no link at all", async ({ page }) => {
  await mount(page, { status: "verification_unavailable", reason: "no_credential" });

  await expect(page.locator("#ega766")).toContainText("Pull request state unavailable");
  await expect(page.locator("#ega766 a")).toHaveCount(0);
});

test("no pull request is reported as its own outcome", async ({ page }) => {
  await mount(page, { status: "no_pr" });

  await expect(page.locator("#ega766")).toContainText("No pull request");
  await expect(page.locator("#ega766 a")).toHaveCount(0);
});

test("a review line appears only when the source gave a decision", async ({ page }) => {
  await mount(page, {
    status: "verified_open",
    pullRequest: verifiedPullRequest,
    review: { status: "unknown", source: "github" },
    readiness: "unknown",
  });
  await expect(page.locator("#ega766 [data-role='review']")).toHaveCount(0);

  await page.evaluate(() => document.getElementById("ega766")?.remove());
  await mount(page, {
    status: "verified_open",
    pullRequest: verifiedPullRequest,
    review: { status: "approved", source: "github" },
    readiness: "ready_to_merge",
  });
  await expect(page.locator("#ega766 [data-role='review']")).toHaveCount(1);
  await expect(page.locator("#ega766 [data-role='review']")).toHaveText("Approved by a reviewer");
});
