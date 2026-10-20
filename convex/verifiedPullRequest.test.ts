import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EGA-766 — boundary guards for the pull-request verification path.
 *
 * These are deliberately SOURCE-based, matching the idiom already used by
 * `convex/t3WriteCapability.test.ts`: a future edit that widens Helm's reach
 * fails the build instead of quietly shipping.
 *
 * Three boundaries are asserted here:
 *
 *  1. Helm has **no Git write or merge path**. The only Git host reference in
 *     the whole source tree is the read-only client, and that client only ever
 *     issues `GET`.
 *  2. The verification **persists nothing**. It is a read-time projection, so
 *     there is no table, no mutation and no speculative state to store.
 *  3. The verification **authorizes the owner before it reads anything**, and
 *     the action's contract covers all six states, so none of them can be
 *     dropped by accident.
 */

const repoRoot = join(import.meta.dirname, "..");

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stats = readdirSync(directory, { withFileTypes: true })
        .find((candidate) => candidate.name === entry);
      if (stats?.isDirectory()) {
        if (entry === "node_modules" || entry === "_generated" || entry === ".next") continue;
        walk(absolute);
        continue;
      }
      // Test files are excluded: this guard quotes the very strings it
      // forbids, and a guard must not trip over its own source.
      if (/\.(test|spec)\.(ts|tsx)$/u.test(entry)) continue;
      if (/\.(ts|tsx)$/u.test(entry)) found.push(absolute);
    }
  };
  walk(root);
  return found;
}

const read = (absolute: string) => readFileSync(absolute, "utf8");
const relativeToRepo = (absolute: string) => relative(repoRoot, absolute).split("\\").join("/");

describe("EGA-766 has no Git write or merge path", () => {
  it("references the GitHub API in exactly one read-only module", () => {
    const referencing = sourceFiles(join(repoRoot, "convex"))
      .concat(sourceFiles(join(repoRoot, "src")))
      .filter((file) => read(file).includes("api.github.com"))
      .map(relativeToRepo);
    expect(referencing).toEqual(["convex/lib/verifiedPullRequest.ts"]);
  });

  it("issues only GET requests to the GitHub API", () => {
    const client = read(join(repoRoot, "convex/lib/verifiedPullRequest.ts"));
    expect(client).toContain('method: "GET"');
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(client).not.toContain(`method: "${method}"`);
    }
  });

  it("never calls a GitHub write or merge endpoint", () => {
    const forbidden = [
      /\/merge\b/u,
      /\/pulls\/\$\{[^}]*\}\/merge/u,
      /\bgit\s+push\b/u,
      /\bgh\s+pr\s+merge\b/u,
      /\bmerge_pull_request\b/u,
    ];
    for (const file of sourceFiles(join(repoRoot, "convex")).concat(sourceFiles(join(repoRoot, "src")))) {
      const text = read(file);
      for (const pattern of forbidden) {
        expect({ file: relativeToRepo(file), pattern: String(pattern), match: pattern.test(text) })
          .toEqual({ file: relativeToRepo(file), pattern: String(pattern), match: false });
      }
    }
  });
});

describe("EGA-766 persists no speculative state", () => {
  it("keeps the verification action free of database writes", () => {
    const action = read(join(repoRoot, "convex/verifiedPullRequest.ts"));
    expect(action).not.toContain("ctx.db");
    expect(action).not.toContain("ctx.runMutation");
    expect(action).not.toContain("ctx.scheduler");
  });

  it("adds no table for verified pull requests", () => {
    const schema = read(join(repoRoot, "convex/schema.ts"));
    expect(schema).not.toContain("verifiedPullRequest");
    expect(schema).not.toContain("pullRequestVerification");
  });
});

describe("EGA-766 authorizes the owner before it reads", () => {
  it("checks the owner grant before any T3 or GitHub call", () => {
    const action = read(join(repoRoot, "convex/verifiedPullRequest.ts"));
    // Only the action handler matters; the helper above it also reads T3.
    const handler = action.slice(action.indexOf("export const verify"));
    const ownerCheck = handler.indexOf("internal.t3ConnectionsStore.ownerContext");
    const t3Read = handler.indexOf("await ctx.runAction(api.t3OAuth.read");
    const gitHubRead = handler.indexOf("await requestGitHubPullRequest(");
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(t3Read).toBeGreaterThan(ownerCheck);
    expect(gitHubRead).toBeGreaterThan(ownerCheck);
  });

  it("keeps every state in the action's contract", () => {
    const action = read(join(repoRoot, "convex/verifiedPullRequest.ts"));
    for (const status of [
      "no_pr",
      "unverified_report",
      "verified_open",
      "verified_closed",
      "verified_merged",
      "verification_unavailable",
    ]) {
      expect(action).toContain(`v.literal("${status}")`);
    }
  });
});
