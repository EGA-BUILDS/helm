import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * The cron registry is discovered SILENTLY: Convex finds `convex/crons.ts`
 * by module path and installs what it finds. A rename would install ZERO
 * crons with no error anywhere, and `convex-test` does not evaluate the
 * crons module at all — so nothing else in this repository would notice.
 * This guard is the only thing standing between a rename and a product
 * whose periodic driver never runs.
 */
describe("cron rename guard", () => {
  it("convex/crons.ts exists and default-exports the cron registry", () => {
    const src = readFileSync(join(import.meta.dirname, "crons.ts"), "utf8");
    expect(src).toContain("cronJobs()");
    expect(src).toMatch(/export default crons;/);
  });

  it("the default export really is a Crons object", async () => {
    const mod = await import("./crons");
    const exported = mod.default as unknown as { isCrons?: boolean; crons?: unknown };
    expect(exported).toBeTypeOf("object");
    // `cronJobs()` returns a `Crons` instance; the deployment recognises it
    // by this marker.
    expect(exported.isCrons).toBe(true);
    expect(exported.crons).toBeTypeOf("object");
  });

  it("the periodic Linear sync driver is registered on the registry", async () => {
    const mod = await import("./crons");
    const exported = mod.default as unknown as {
      crons: Record<string, { name: string; schedule: { type: string; minutes?: number } }>;
    };
    const entries = Object.entries(exported.crons);
    expect(entries.length).toBeGreaterThan(0);
    const driver = entries.find(([name]) => name.includes("linear sync"));
    expect(driver).toBeDefined();
    expect(driver![1].schedule).toMatchObject({ type: "interval", minutes: 5 });
    // The registered target is the periodic driver itself.
    expect(driver![1].name).toContain("driveRetryable");
  });

  it("a registry built by cronJobs() accepts an interval registration", () => {
    // The shape the module relies on: `cronJobs()` -> `interval(...)` ->
    // default export. If the Convex API changed, this fails here.
    const crons = cronJobs();
    crons.interval("probe", { minutes: 5 }, internal.linearSync.driveRetryable, {});
    expect(crons.isCrons).toBe(true);
    expect(Object.keys(crons.crons)).toEqual(["probe"]);
  });
});
