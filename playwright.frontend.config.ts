import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve("node_modules/.cache/ms-playwright");

export default defineConfig({
  testDir: "./tests/frontend",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", ...devices["Desktop Chrome"], trace: "off" },
  webServer: { command: "node tests/frontend/serve.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
