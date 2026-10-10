import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import schema from "./schema";

/**
 * EGA-677 hardening guard.
 *
 * Every function that can change execution state must be internal. These tests
 * assert it from the source rather than from a deployment snapshot, so a future
 * `export const x = mutation({` fails the build instead of quietly reopening the
 * deployment to any client that can reach its URL.
 */
const PUBLIC_KINDS = /=\s*(mutation|query|action)\s*\(/;
const EXECUTION_STATE_FILES = [
  "launchAttempts.ts",
  "credentials.ts",
  "dispatch.ts",
];

describe("execution-state authorization", () => {
  it("no public mutation/query/action exists in execution-state modules", () => {
    const offenders: string[] = [];
    for (const file of EXECUTION_STATE_FILES) {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      src.split("\n").forEach((line, i) => {
        if (PUBLIC_KINDS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every execution-state module declares at least one internal function", () => {
    for (const file of EXECUTION_STATE_FILES) {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(src, `${file} declares no internal* function`).toMatch(
        /= internal(Mutation|Query|Action)\s*\(/,
      );
    }
  });

  it("dispatch reads the credential gate through the internal namespace", () => {
    const src = readFileSync(join(import.meta.dirname, "dispatch.ts"), "utf8");
    // A public reference would silently bypass the internal boundary.
    expect(src).not.toMatch(/\bapi\./);
    expect(src).toContain("internal.credentials.canDispatch");
    expect(src).toContain("internal.launchAttempts.prepareLaunchAttempt");
  });

  it("dispatch never authorizes a relaunch", () => {
    const src = readFileSync(join(import.meta.dirname, "dispatch.ts"), "utf8");
    expect(src).not.toMatch(/relaunchAuthorized:\s*true/);
  });

  it("public functions are explicitly allowlisted as health or owner protected", () => {
    const found: string[] = [];
    // Recursive: a public function smuggled into a subdirectory (e.g.
    // convex/integration/foo.ts) must be caught too.
    const entries = readdirSync(join(import.meta.dirname), {
      recursive: true,
    }) as string[];
    for (const file of entries) {
      if (file.includes("node_modules")) continue;
      if (file.split("/").some((part) => part.startsWith("."))) continue;
      if (file === "_generated" || file.startsWith("_generated/")) continue;
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const line of src.split("\n")) {
        const m = line.match(/export const (\w+)\s*=\s*(mutation|query|action)\s*\(/);
        if (m) found.push(`${file}:${m[1]}`);
      }
    }
    // Counting declarations, not files: a second public function smuggled into an
    // already-allowed file must still fail.
    expect(found).toEqual(["auth.ts:session", "health.ts:check"]);
    expect(readFileSync(join(import.meta.dirname, "auth.ts"), "utf8")).toContain("requireOwner(ctx)");
  });

  it("reconciliation refuses to treat zero or many matches as settled", async () => {
    const modules = import.meta.glob("./**/*.ts");
    const t = convexTest(schema, modules);

    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677-Z",
      attemptId: "zero",
      payloadHash: "a".repeat(64),
    });
    const zero = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "zero",
      matchCount: 0,
      threadId: null,
    });
    expect(zero.state).toBe("ambiguous");
    expect(zero.safeToProceed).toBe(false);
    expect(zero.relaunchAuthorized).toBe(false);

    await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-677-M",
      attemptId: "many",
      payloadHash: "b".repeat(64),
    });
    const many = await t.mutation(internal.launchAttempts.recordReconciliation, {
      attemptId: "many",
      matchCount: 2,
      threadId: null,
    });
    expect(many.state).toBe("ambiguous");
    expect(many.safeToProceed).toBe(false);
    expect(many.relaunchAuthorized).toBe(false);
  });
});

describe("owner authorization source boundaries", () => {
  it("denies anonymous and other authenticated direct Convex calls", async () => {
    const modules = import.meta.glob("./**/*.ts");
    const t = convexTest(schema, modules);
    await expect(t.query(api.auth.session, {})).rejects.toThrow(/unauthorized/);
    const other = t.withIdentity({ issuer: "https://test-issuer.example", subject: "user_other" });
    await expect(other.query(api.auth.session, {})).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.health.check, {})).resolves.toEqual({ status: "ok" });
  });
});
