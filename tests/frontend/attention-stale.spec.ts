import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Stale-response proof for the identity-keyed attention read.
 *
 * Thread A's read is left pending, the owner selects thread B, and only then
 * does A resolve with `needs_attention`. The badge must never show A's answer
 * against B: the receipt is keyed by the exact connection/project/thread that
 * produced it, and the superseded request is aborted.
 */

const harnessUrl = `/@fs${resolve(process.cwd(), "src/features/t3/attentionHarness.tsx")}`;
const A = "5e476b4f-047e-4d72-bbfc-15d9498d31e4";
const B = "thread:provider:codex:native-thread:01a1a77d-831c-7c72-9032-bc61e00c205c";

type Control = {
  select(threadId: string): void;
  pending(): string[];
  resolve(threadId: string, result: unknown): void;
};

declare global {
  interface Window {
    __attentionHarness: Control;
  }
}

async function select(page: Page, threadId: string): Promise<void> {
  await page.evaluate((value) => window.__attentionHarness.select(value), threadId);
}

async function resolveRead(page: Page, threadId: string, state: "needs_attention" | "idle"): Promise<void> {
  await page.evaluate((input) => {
    window.__attentionHarness.resolve(input.threadId, {
      state: input.state,
      basis: input.basis,
      observedAt: "2026-11-04T00:00:00.000Z",
      t3Reference: `Open T3 thread ${input.threadId} in project t3-proj-1 to review and act.`,
    });
  }, {
    threadId,
    state,
    basis: state === "needs_attention" ? "STALE THREAD A: awaiting approval" : "Every observed run reached a terminal state; nothing is waiting.",
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const container = document.createElement("div");
    container.id = "attention-stale";
    document.body.appendChild(container);
  });
  await page.addScriptTag({
    type: "module",
    content: [
      `import { mountAttentionHarness } from ${JSON.stringify(harnessUrl)};`,
      `mountAttentionHarness(document.getElementById("attention-stale"), ${JSON.stringify(A)});`,
    ].join("\n"),
  });
  await expect(page.locator("#attention-stale")).toContainText("Reading native attention state");
  await page.waitForFunction(() => window.__attentionHarness?.pending().length === 1);
});

test("a late attention response for the previous thread is never rendered", async ({ page }) => {
  // Select B while A is still in flight.
  await select(page, B);
  await page.waitForFunction((threadB) => {
    const pending = window.__attentionHarness?.pending() ?? [];
    return pending.length === 2 && pending.includes(threadB);
  }, B);

  // A resolves late, with evidence that WOULD justify needs_attention.
  await resolveRead(page, A, "needs_attention");
  await page.waitForTimeout(150);

  // B is still the selection, so the UI must still be reading B — never A's
  // needs_attention verdict and never A's basis.
  await expect(page.locator("#attention-stale")).toContainText("Reading native attention state");
  await expect(page.locator("#attention-stale")).not.toContainText("Needs attention");
  await expect(page.locator("#attention-stale")).not.toContainText("STALE THREAD A");

  // B's own response is what the owner sees.
  await resolveRead(page, B, "idle");
  await expect(page.locator("#attention-stale")).toContainText("Idle");
  await expect(page.locator("#attention-stale")).not.toContainText("STALE THREAD A");
});
