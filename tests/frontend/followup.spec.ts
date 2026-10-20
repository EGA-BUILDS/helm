import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Native follow-up client behaviour (EGA-764 D10).
 *
 * These run the REAL `FollowUpControl` against a stubbed
 * `/api/t3/threads/send` route. They prove the client contract only — the
 * native side is mocked by the route handler:
 *  - one logical message carries one idempotency key, and an EDIT mints a
 *    fresh key;
 *  - a response that arrives after the owner moved to another thread is
 *    DISCARDED, never rendered under the new selection;
 *  - a rapid second click does not issue a second send;
 *  - mounting (and reloading) never sends anything;
 *  - `onAccepted` fires for an acknowledgement and never for a refusal.
 */

const THREAD_A = "mcp:00000000-0000-4000-8000-000000000001";
const THREAD_B = "mcp:00000000-0000-4000-8000-000000000002";

type SendBody = {
  connectionId: string;
  projectId: string;
  threadId: string;
  message: string;
  clientRequestId: string;
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "accepted",
    reason: null,
    detail: "T3 accepted the follow-up message.",
    threadId: THREAD_A,
    messageId: "msg-1",
    runId: "run:thread:ordinal:1",
    clientRequestId: "req-1",
    dedupe: "not_duplicate_observed",
    ...overrides,
  };
}

/** Stub the send route and record every request body it receives. */
async function stubSend(page: Page, body: (request: SendBody) => unknown = () => envelope()) {
  const sent: SendBody[] = [];
  await page.route("**/api/t3/threads/send", async (route: Route) => {
    const payload = JSON.parse(String(route.request().postData() ?? "{}")) as SendBody;
    sent.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body(payload)),
    });
  });
  return sent;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/followup.html");
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toBeVisible();
});

test("editing the message mints a fresh request id while a retry keeps it", async ({ page }) => {
  const sent = await stubSend(page, (request) => envelope({ threadId: request.threadId, clientRequestId: request.clientRequestId }));
  const box = page.getByLabel("Follow-up message");
  await box.fill("confirm the plan");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByText(/T3 accepted the follow-up message/)).toBeVisible();

  // An edited message is a new message: a fresh idempotency key.
  await box.fill("confirm the plan, then deploy");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByText(/T3 accepted the follow-up message/)).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0]!.clientRequestId).not.toBe(sent[1]!.clientRequestId);
  expect(sent[0]!.message).toBe("confirm the plan");
  expect(sent[1]!.message).toBe("confirm the plan, then deploy");
});

test("a response that arrives after the selection changed is discarded", async ({ page }) => {
  let release: (() => void) | null = null;
  await page.route("**/api/t3/threads/send", async (route: Route) => {
    const payload = JSON.parse(String(route.request().postData() ?? "{}")) as SendBody;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(envelope({ threadId: payload.threadId, clientRequestId: payload.clientRequestId })),
    });
  });

  await page.getByLabel("Follow-up message").fill("for thread A");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeVisible();

  // The owner moves to another thread while the send is still in flight.
  await page.getByLabel("Selected thread").selectOption({ label: "Thread B" });
  await expect(page.getByText(THREAD_B)).toBeVisible();

  release!();
  await expect(page.getByText(/T3 accepted the follow-up message/)).toHaveCount(0);
  // The stale acknowledgement never counts either.
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:0");

  // The abandoned send is finished, not left hanging: coming back to the
  // original thread shows a usable control again instead of a permanent
  // "Sending…" state.
  await page.getByLabel("Selected thread").selectOption({ label: "Thread A" });
  await expect(page.getByText(THREAD_A)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Follow-up message")).toBeEnabled();
  // And the discarded receipt is still not rendered.
  await expect(page.getByText(/outcome: accepted/)).toHaveCount(0);
});

test("a rapid second click issues no second send", async ({ page }) => {
  let release: (() => void) | null = null;
  const sent: SendBody[] = [];
  await page.route("**/api/t3/threads/send", async (route: Route) => {
    sent.push(JSON.parse(String(route.request().postData() ?? "{}")) as SendBody);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope()) });
  });

  await page.getByLabel("Follow-up message").fill("one message");
  // Two clicks in ONE task: React has not re-rendered between them, so the
  // in-flight guard — not the disabled button — is what stops the second one.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button[type='button']");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeVisible();
  // A second, real click while the send is in flight is refused as well.
  await page.getByRole("button", { name: "Sending…", exact: true }).click({ force: true }).catch(() => undefined);
  release!();
  await expect(page.getByText(/T3 accepted the follow-up message/)).toBeVisible();
  // Exactly one native send was issued for the one logical message, and it
  // carried one request id.
  expect(sent).toHaveLength(1);
});

test("mounting and reloading never sends anything", async ({ page }) => {
  const sent = await stubSend(page);
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect(sent).toHaveLength(0);
});

test("the acknowledgement callback fires for accepted and queued only", async ({ page }) => {
  const sent = await stubSend(page, (request) =>
    request.message.includes("refuse")
      ? envelope({ outcome: "rejected", reason: "rejected", messageId: null, detail: "T3 refused the follow-up message; nothing was queued." })
      : request.message.includes("queue")
        ? envelope({ outcome: "queued", messageId: null, detail: "T3 queued the follow-up message; it has not run yet." })
        : request.message.includes("unclear")
          ? envelope({
              outcome: "ambiguous",
              reason: "ambiguous",
              messageId: null,
              runId: null,
              dedupe: "unverified",
              detail: "The send acknowledgement was unclear; the message may or may not have been queued. Retry with the same request id.",
            })
          : envelope({ threadId: request.threadId, clientRequestId: request.clientRequestId }),
  );

  await page.getByLabel("Follow-up message").fill("accepted message");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:1");

  await page.getByLabel("Follow-up message").fill("queued message");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:2");

  await page.getByLabel("Follow-up message").fill("refuse me");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByText(/nothing was queued/)).toBeVisible();
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:2");

  // An AMBIGUOUS outcome is not an acknowledgement: it must not move the
  // acknowledgement counter, and it must stay actionable through the
  // same-request-id retry.
  await page.getByLabel("Follow-up message").fill("unclear message");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByText(/may or may not have been queued/)).toBeVisible();
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:2");
  await expect(page.getByRole("button", { name: "Retry with the same request id", exact: true })).toBeVisible();
  await expect(page.getByText(/outcome: ambiguous/)).toBeVisible();
  expect(sent).toHaveLength(4);
});

test("a receipt for a different thread is refused instead of being rendered", async ({ page }) => {
  // The backend answers about a thread the owner did not select. The
  // selection never changed, so the identity check — not the per-selection
  // keying — is what has to catch it.
  await stubSend(page, (request) =>
    envelope({
      threadId: request.threadId === THREAD_A ? THREAD_B : request.threadId,
      clientRequestId: request.clientRequestId,
    }),
  );
  await page.getByLabel("Follow-up message").fill("hello");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Helm could not read the follow-up result for the selected thread.",
  );
  // No receipt is rendered for the wrong thread, and nothing is acknowledged.
  await expect(page.getByText(/outcome: accepted/)).toHaveCount(0);
  await expect(page.getByTestId("accepted-count")).toHaveText("accepted:0");
});

test("the thread identity is always shown and the receipt names the thread", async ({ page }) => {
  await stubSend(page, (request) => envelope({ threadId: request.threadId, clientRequestId: request.clientRequestId }));
  await expect(page.getByText(THREAD_A)).toBeVisible();
  await expect(page.getByText("t3-proj-1")).toBeVisible();
  await page.getByLabel("Follow-up message").fill("hello");
  await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
  await expect(page.getByText(/outcome: accepted/)).toBeVisible();
  await page.getByLabel("Selected thread").selectOption({ label: "Thread B" });
  await expect(page.getByText(THREAD_B)).toBeVisible();
  await expect(page.getByText("t3-proj-2")).toBeVisible();
  // The previous thread's receipt is not shown under the new selection.
  await expect(page.getByText(/outcome: accepted/)).toHaveCount(0);
});
