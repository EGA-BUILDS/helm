import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const ownerEmail = process.env.E2E_OWNER_EMAIL;
const otherEmail = process.env.E2E_OTHER_EMAIL;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

async function signIn(page: Page, emailAddress: string) {
  await page.goto("/");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress });
}

async function getConvexToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const clerk = window.Clerk;
    if (!clerk?.session) return null;
    return clerk.session.getToken();
  });
  if (!token) throw new Error("Clerk did not provide a Convex session token");
  return token;
}

function directClient(token?: string) {
  if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is required for backend E2E checks");
  const client = new ConvexHttpClient(convexUrl);
  if (token) client.setAuth(token);
  return client;
}

test("signed-out access stays private and public health remains available", async ({ page }) => {
  const response = await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Helm" })).toBeVisible();
  await expect(page.getByText("Private owner dashboard")).toHaveCount(0);
  await expect(page.getByText("Owner access verified by Convex.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /sign up/i })).toHaveCount(0);

  const html = await response?.text() ?? "";
  expect(html).not.toMatch(/sk_(?:test|live)_[A-Za-z0-9]+/);
  expect(html).not.toContain("CLERK_SECRET_KEY");
  expect(html).not.toContain("T3_MCP_TOKEN");
  expect(html).not.toContain("LINEAR_API_KEY");

  await expect(directClient().query(api.health.check, {})).resolves.toEqual({ status: "ok" });
  await expect(directClient().query(api.auth.session, {})).rejects.toThrow(/unauthorized/i);
});

test("approved owner can sign in, refresh, and sign out", async ({ page }) => {
  await signIn(page, ownerEmail!);
  await expect(page.getByText("Owner access verified by Convex.")).toBeVisible();

  const token = await getConvexToken(page);
  await expect(directClient(token).query(api.auth.session, {})).resolves.toEqual({
    authorized: true,
    application: "helm",
    session: "owner",
  });

  await page.reload();
  await expect(page.getByText("Owner access verified by Convex.")).toBeVisible();
  await clerk.signOut({ page });
  await expect(page.getByRole("heading", { name: "Sign in to Helm" })).toBeVisible();
  await expect(page.getByText("Private owner dashboard")).toHaveCount(0);
  await expect(directClient().query(api.auth.session, {})).rejects.toThrow(/unauthorized/i);
});

test("a second valid Clerk identity is denied in the UI and directly by Convex", async ({ page }) => {
  await signIn(page, otherEmail!);
  await expect(page.getByRole("heading", { name: "Not the Helm owner" })).toBeVisible();
  await expect(page.getByText("Owner access verified by Convex.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /launch|execute|dispatch/i })).toHaveCount(0);

  const token = await getConvexToken(page);
  await expect(directClient(token).query(api.auth.session, {})).rejects.toThrow(/unauthorized/i);
});

test("an invalid token is rejected by the live DEV backend", async () => {
  await expect(directClient("invalid.test-token").query(api.auth.session, {}))
    .rejects.toThrow();
});

test("an expired owner session token is rejected by the live DEV backend", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, ownerEmail!);
  const token = await getConvexToken(page);
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Clerk returned a malformed session token");

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
  if (!claims.exp || claims.exp * 1000 <= Date.now()) {
    throw new Error("Clerk returned a session token without a future expiration");
  }

  const expiresAt = claims.exp * 1000;
  await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() + 1_500));
  await expect(directClient(token).query(api.auth.session, {})).rejects.toThrow();
});
