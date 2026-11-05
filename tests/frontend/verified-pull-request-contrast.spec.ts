import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * EGA-766 follow-up — the pull-request card must be readable in both color
 * schemes, not an almost-white panel in dark mode.
 *
 * The assertions are computed-style checks in a real browser (Playwright's
 * `colorScheme` switch): the card's own background/text contrast must clear
 * 4.5:1 in light AND dark, while all four presentation states (verified,
 * unverified, no pull request, unavailable) keep their distinct copy and the
 * verified state keeps the only link.
 */

const harnessUrl = `/@fs${resolve(process.cwd(), "src/features/t3/verifiedPullRequestHarness.tsx")}`;

const pullRequest = {
  number: 42,
  owner: "EGA-BUILDS",
  name: "helm",
  url: "https://github.com/EGA-BUILDS/helm/pull/42",
  baseBranch: "develop",
  headBranch: "feat/ega-766",
  headRepository: "EGA-BUILDS/helm",
  isDraft: false,
  mergedAt: null,
  identitySource: "operator_configuration",
  threadId: "5e476b4f-047e-4d72-bbfc-15d9498d31e4",
  observedAt: "2026-10-20T12:00:00.000Z",
};

const STATES = {
  verified: {
    status: "verified_open",
    pullRequest,
    review: { status: "approved", source: "github" },
    readiness: "unknown",
  },
  unverified: {
    status: "unverified_report",
    reason: "non_github_url",
    claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
  },
  no_pr: { status: "no_pr" },
  unavailable: { status: "verification_unavailable", reason: "no_credential" },
} as const;

async function mount(page: Page, verification: unknown): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("ega766-contrast")?.remove();
    const container = document.createElement("div");
    container.id = "ega766-contrast";
    document.body.appendChild(container);
  });
  await page.addScriptTag({
    type: "module",
    content: [
      `import { mountVerifiedPullRequestCard } from ${JSON.stringify(harnessUrl)};`,
      `mountVerifiedPullRequestCard(document.getElementById("ega766-contrast"), ${JSON.stringify(verification)});`,
    ].join("\n"),
  });
  await expect(page.locator("#ega766-contrast section")).toBeVisible();
}

type Readability = {
  kind: string | null;
  background: [number, number, number];
  ratios: { role: string; ratio: number }[];
  hasLink: boolean;
};

async function readability(page: Page): Promise<Readability> {
  return await page.evaluate(() => {
    const parse = (value: string): [number, number, number] => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
      if (!match) throw new Error(`unexpected color ${value}`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: [number, number, number], b: [number, number, number]): number => {
      const la = luminance(a);
      const lb = luminance(b);
      const [hi, lo] = la > lb ? [la, lb] : [lb, la];
      return (hi + 0.05) / (lo + 0.05);
    };

    const section = document.querySelector("#ega766-contrast section");
    if (!section) throw new Error("card missing");
    const background = parse(getComputedStyle(section).backgroundColor);
    const targets = [
      ["title", "#ega766-contrast h3"],
      ["detail", "#ega766-contrast [data-role='detail'], #ega766-contrast [data-role='unverified-detail']"],
      ["eyebrow", "#ega766-contrast p:first-child"],
      ["review", "#ega766-contrast [data-role='review']"],
      ["link", "#ega766-contrast [data-role='pull-request-link']"],
      ["caveat", "#ega766-contrast [data-role='caveat']"],
    ] as const;
    const ratios = targets.flatMap(([role, selector]) => {
      const element = document.querySelector(selector);
      if (!element) return [];
      return [{ role, ratio: ratio(parse(getComputedStyle(element).color), background) }];
    });
    return {
      kind: section.getAttribute("data-kind"),
      background,
      ratios,
      hasLink: document.querySelector("#ega766-contrast [data-role='pull-request-link']") !== null,
    };
  });
}

async function expectReadable(page: Page, state: keyof typeof STATES, kind: string) {
  await mount(page, STATES[state]);
  const result = await readability(page);
  expect(result.kind).toBe(kind);
  expect(result.ratios.length).toBeGreaterThan(0);
  for (const { role, ratio } of result.ratios) {
    expect(ratio, `${state} ${role} contrast`).toBeGreaterThanOrEqual(4.5);
  }
  expect(result.hasLink).toBe(state === "verified");
  return result;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test.describe("light color scheme", () => {
  test.use({ colorScheme: "light" });

  test("all four states are readable", async ({ page }) => {
    const results = [];
    results.push(await expectReadable(page, "verified", "verified"));
    results.push(await expectReadable(page, "unverified", "unverified"));
    results.push(await expectReadable(page, "no_pr", "no_pr"));
    results.push(await expectReadable(page, "unavailable", "unavailable"));
    for (const result of results) {
      // A light card: high luminance background.
      expect(result.background[0], "light background").toBeGreaterThan(200);
    }
  });
});

test.describe("dark color scheme", () => {
  test.use({ colorScheme: "dark" });

  test("all four states are readable on a dark card", async ({ page }) => {
    const results = [];
    results.push(await expectReadable(page, "verified", "verified"));
    results.push(await expectReadable(page, "unverified", "unverified"));
    results.push(await expectReadable(page, "no_pr", "no_pr"));
    results.push(await expectReadable(page, "unavailable", "unavailable"));
    for (const result of results) {
      // The regression was an almost-white panel. Dark mode must actually
      // paint a dark surface, not merely inherit light tokens.
      expect(result.background[0], "dark background").toBeLessThan(80);
      expect(result.background[1], "dark background").toBeLessThan(80);
      expect(result.background[2], "dark background").toBeLessThan(80);
    }
  });

  test("the card switches surfaces between schemes", async ({ page }) => {
    await mount(page, STATES.verified);
    const dark = await readability(page);
    // Emulate light on the same page and re-read: the module must react to the
    // media query rather than freezing the first value.
    await page.emulateMedia({ colorScheme: "light" });
    const light = await readability(page);
    expect(dark.background).not.toEqual(light.background);
    expect(dark.background[0]).toBeLessThan(light.background[0]);
  });
});
