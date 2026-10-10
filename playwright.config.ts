import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const localEnvPath = resolve(process.cwd(), ".env.local");
const e2eEnvNames = new Set([
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CONVEX_URL",
  "E2E_OWNER_EMAIL",
  "E2E_OTHER_EMAIL",
]);

try {
  for (const line of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !e2eEnvNames.has(match[1]) || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {
  // The explicit E2E validation below reports absent configuration.
}

if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  throw new Error("Playwright E2E requires Clerk Development keys in .env.local or the process environment.");
}
if (!process.env.E2E_OWNER_EMAIL || !process.env.E2E_OTHER_EMAIL) {
  throw new Error("Playwright acceptance E2E requires E2E_OWNER_EMAIL and E2E_OTHER_EMAIL for Clerk Development accounts.");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  globalSetup: "./playwright.global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "off",
    screenshot: "off",
    video: "off",
    ...devices["Desktop Chrome"],
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: !process.env.CI,
        env: { NEXT_TELEMETRY_DISABLED: "1" },
      },
});
