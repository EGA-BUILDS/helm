/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * EGA-766 — the owner path of the pull-request verification action, plus the
 * boundary guards that keep Helm's reach read-only.
 *
 * ## Owner-path tests
 *
 * These run the REAL action as the REAL owner, with the T3 read stubbed at
 * the module boundary (no T3 server, no network, no credential). They cover
 * the paths a unit test of the pure core cannot:
 *
 *  - without `GITHUB_TOKEN` the action returns
 *    `verification_unavailable` / `no_credential` and never touches the
 *    network;
 *  - a thread that reports no branch yields `unverified_report` /
 *    `thread_not_bound`, so nothing is ever verified "because a pull request
 *    with that number exists";
 *  - a forged URL in the claim yields `unverified_report` /
 *    `non_github_url`.
 *
 * ## Boundary guards
 *
 * These assert from SOURCE, matching the idiom already used by
 * `convex/t3WriteCapability.test.ts`: a future edit that widens Helm's reach
 * fails the build instead of quietly shipping.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const THREAD_ID = "mcp:58ee0336-b6be-489c-8462-3bc18246e5b3";
const PROJECT_ID = "proj-1";

/** A claim that carries every field Helm verifies. */
const CLAIM = {
  url: "https://github.com/EGA-BUILDS/helm/pull/42",
  number: 42,
  baseBranch: "develop",
  headBranch: "feat/ega-766",
  state: "open",
};

type FakeThread = {
  branch?: string | null;
  linkedPullRequest?: unknown;
};

/**
 * The T3 read, stubbed at the module boundary.
 *
 * Only `read` is replaced, and only for these tests: the rest of the convex
 * surface (the owner grant, the connection store) is the real thing.
 */
function fakeT3Read(thread: FakeThread) {
  return {
    read: action({
      args: { connectionId: v.string(), operation: v.string(), input: v.optional(v.any()) },
      returns: v.any(),
      handler: async (_ctx, args: { operation: string }) => {
        if (args.operation === "thread") {
          return {
            thread: {
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              branch: thread.branch ?? null,
              linkedPullRequest: thread.linkedPullRequest ?? null,
            },
          };
        }
        return { projectId: PROJECT_ID, repositoryIdentity: "EGA-BUILDS/helm" };
      },
    }),
  };
}

const glob = import.meta.glob("./**/*.ts");

function harness(thread: FakeThread) {
  const modules = { ...glob, "./t3OAuth.ts": () => Promise.resolve(fakeT3Read(thread)) };
  return convexTest(schema, modules);
}

async function ownerHarness(thread: FakeThread) {
  const t = harness(thread);
  await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  const connectionId = await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
    ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
    endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
    resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client",
    environmentId: "env-1", environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64",
    access: "read-only", status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder",
    credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(), updatedAt: Date.now(),
    lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
  }));
  const owner = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  return { owner, connectionId: connectionId as Id<"t3Connections"> };
}

describe("EGA-766 owner path of the verification action", () => {
  let savedToken: string | undefined;
  let savedOwner: Record<string, string | undefined>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedToken = process.env.GITHUB_TOKEN;
    savedOwner = {
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
      HELM_GITHUB_REPOSITORY: process.env.HELM_GITHUB_REPOSITORY,
    };
    delete process.env.GITHUB_TOKEN;
    delete process.env.HELM_GITHUB_REPOSITORY;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    // Any outbound request fails the test: the action must not reach GitHub
    // without a credential.
    fetchSpy = vi.fn(async () => {
      throw new Error("the verification action must not reach GitHub in this test");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    for (const [name, value] of Object.entries(savedOwner)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  it("reports verification_unavailable with no_credential when GITHUB_TOKEN is unset", async () => {
    const { owner, connectionId } = await ownerHarness({ branch: "feat/ega-766", linkedPullRequest: CLAIM });
    const result = await owner.action(api.verifiedPullRequest.verify, {
      connectionId,
      threadId: THREAD_ID,
    });
    expect(result).toEqual({ status: "verification_unavailable", reason: "no_credential" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never verifies a thread that reports no branch", async () => {
    const { owner, connectionId } = await ownerHarness({ branch: null, linkedPullRequest: CLAIM });
    const result = await owner.action(api.verifiedPullRequest.verify, {
      connectionId,
      threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ status: "unverified_report", reason: "thread_not_bound" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never verifies a forged pull-request URL", async () => {
    const { owner, connectionId } = await ownerHarness({
      branch: "feat/ega-766",
      linkedPullRequest: { ...CLAIM, url: "https://evil.example.com/EGA-BUILDS/helm/pull/42" },
    });
    const result = await owner.action(api.verifiedPullRequest.verify, {
      connectionId,
      threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ status: "unverified_report", reason: "non_github_url" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports no pull request when T3 links none, without asking GitHub", async () => {
    const { owner, connectionId } = await ownerHarness({ branch: "feat/ega-766", linkedPullRequest: null });
    const result = await owner.action(api.verifiedPullRequest.verify, {
      connectionId,
      threadId: THREAD_ID,
    });
    expect(result).toEqual({ status: "no_pr" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

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

  it("never reaches GitHub before the credential check", () => {
    const action = read(join(repoRoot, "convex/verifiedPullRequest.ts"));
    const handler = action.slice(action.indexOf("export const verify"));
    const credentialCheck = handler.indexOf("if (!token)");
    const gitHubRead = handler.indexOf("await requestGitHubPullRequest(");
    expect(credentialCheck).toBeGreaterThan(-1);
    expect(gitHubRead).toBeGreaterThan(credentialCheck);
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
