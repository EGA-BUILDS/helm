import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("cron rename guard", () => {
  it("convex/crons.ts exists and default-exports the cron registry", () => {
    const src = readFileSync(join(import.meta.dirname, "crons.ts"), "utf8");
    expect(src).toContain('cronJobs()');
    expect(src).toMatch(/export default crons;/);
  });
});
