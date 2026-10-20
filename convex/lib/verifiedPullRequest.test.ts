import { describe, expect, it } from "vitest";
import {
  decidePullRequestVerification,
  normalizeGitHubPullRequest,
  parseGitHubPullRequestUrl,
  parsePullRequestCandidate,
  parseRepositoryIdentity,
  requestGitHubPullRequest,
  resolveRepositoryIdentity,
  screenPullRequestClaim,
  type GitHubLookup,
  type GitHubPullRequest,
  type PullRequestVerification,
  type RepositoryIdentity,
} from "./verifiedPullRequest";

/**
 * EGA-766 — verified pull-request state for native T3 execution.
 *
 * The contract under test: native T3's `linkedPullRequest` is a CLAIM. Only
 * an authoritative GitHub read, bound to a repository identity Helm resolved
 * from an authorized source, may produce a `verified_*` state. Everything else
 * fails closed with a specific reason, and the three "not verified" states
 * (`no_pr`, `unverified_report`, `verification_unavailable`) are never
 * collapsed into each other.
 *
 * No network is used anywhere in this file: the authoritative response is
 * always injected, and the GitHub client is driven by a stub `fetch`.
 */

const identity: RepositoryIdentity = { owner: "EGA-BUILDS", name: "helm", source: "t3_project" };

function githubPullRequest(overrides: Partial<{
  number: number;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  baseRepository: string;
  headRepository: string | null;
  htmlUrl: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeableState: string | null;
}> = {}): GitHubPullRequest {
  const base = {
    number: 42,
    state: "open" as const,
    merged: false,
    mergedAt: null,
    isDraft: false,
    baseRef: "develop",
    headRef: "feat/ega-766",
    baseRepository: "EGA-BUILDS/helm",
    headRepository: "EGA-BUILDS/helm",
    htmlUrl: "https://github.com/EGA-BUILDS/helm/pull/42",
    reviewDecision: null,
    mergeableState: null,
    ...overrides,
  };
  return base;
}

function found(pullRequest: GitHubPullRequest): GitHubLookup {
  return { kind: "found", pullRequest };
}

function decide(
  candidate: unknown,
  response: GitHubLookup,
  overrides: {
    identity?: RepositoryIdentity | null;
    identityConflict?: boolean;
    expectedBaseBranch?: string | null;
    observedAt?: string | null;
  } = {},
): PullRequestVerification {
  return decidePullRequestVerification({
    candidate,
    identity: overrides.identity === undefined ? identity : overrides.identity,
    identityConflict: overrides.identityConflict ?? false,
    expectedBaseBranch: overrides.expectedBaseBranch ?? null,
    response,
    observedAt: overrides.observedAt ?? "2026-10-20T00:00:00.000Z",
  });
}

describe("EGA-766 repository identity", () => {
  it("parses the authorized identity shapes Helm has seen", () => {
    for (const value of [
      "EGA-BUILDS/helm",
      "github.com/EGA-BUILDS/helm",
      "github:EGA-BUILDS/helm",
      "https://github.com/EGA-BUILDS/helm",
      "git@github.com:EGA-BUILDS/helm.git",
      "ssh://git@github.com/EGA-BUILDS/helm.git",
    ]) {
      expect(parseRepositoryIdentity(value)?.owner).toBe("EGA-BUILDS");
      expect(parseRepositoryIdentity(value)?.name).toBe("helm");
    }
  });

  it("refuses an identity it cannot read as owner/name", () => {
    for (const value of [
      "",
      "   ",
      "helm",
      "/home/ubuntu/helm",
      "EGA-BUILDS/helm/extra",
      "https://gitlab.com/EGA-BUILDS/helm",
      "EGA BUILDS/helm",
      null,
      42,
      { owner: "EGA-BUILDS", name: "helm" },
    ]) {
      expect(parseRepositoryIdentity(value)).toBeNull();
    }
  });

  it("refuses to choose between two authorized sources that disagree", () => {
    const resolved = resolveRepositoryIdentity({
      t3ProjectIdentity: "EGA-BUILDS/helm",
      operatorConfigured: "someone-else/helm",
    });
    expect(resolved.conflict).toBe(true);
    expect(resolved.identity).toBeNull();
  });

  it("uses the operator configuration only when the T3 project names no repository", () => {
    const resolved = resolveRepositoryIdentity({
      t3ProjectIdentity: null,
      operatorConfigured: "EGA-BUILDS/helm",
    });
    expect(resolved.conflict).toBe(false);
    expect(resolved.identity?.source).toBe("operator_configuration");
  });
});

describe("EGA-766 claim parsing", () => {
  it("accepts a GitHub pull-request URL", () => {
    const parsed = parseGitHubPullRequestUrl("https://github.com/EGA-BUILDS/helm/pull/42");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.owner).toBe("EGA-BUILDS");
      expect(parsed.value.number).toBe(42);
      expect(parsed.value.href).toBe("https://github.com/EGA-BUILDS/helm/pull/42");
    }
  });

  it("refuses a URL whose host is not GitHub", () => {
    const parsed = parseGitHubPullRequestUrl("https://evil.example.com/EGA-BUILDS/helm/pull/42");
    expect(parsed).toEqual({ ok: false, reason: "non_github_url" });
  });

  it("refuses a URL with a non-numeric pull-request path", () => {
    const parsed = parseGitHubPullRequestUrl("https://github.com/EGA-BUILDS/helm/pull/not-a-number");
    expect(parsed).toEqual({ ok: false, reason: "malformed_pr_number" });
  });

  it("refuses a URL that is not a pull request at all", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/EGA-BUILDS/helm")).toEqual({
      ok: false,
      reason: "malformed_pr_url",
    });
  });

  it("refuses a non-HTTPS or credential-carrying URL", () => {
    expect(parseGitHubPullRequestUrl("http://github.com/EGA-BUILDS/helm/pull/42")).toEqual({
      ok: false,
      reason: "malformed_pr_url",
    });
    expect(parseGitHubPullRequestUrl("https://user:pass@github.com/EGA-BUILDS/helm/pull/42")).toEqual({
      ok: false,
      reason: "malformed_pr_url",
    });
  });

  it("reads a claim that carries a URL and a number", () => {
    const parsed = parsePullRequestCandidate({
      url: "https://github.com/EGA-BUILDS/helm/pull/42",
      number: 42,
      baseBranch: "develop",
      headBranch: "feat/ega-766",
      state: "open",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.candidate.owner).toBe("EGA-BUILDS");
      expect(parsed.candidate.name).toBe("helm");
      expect(parsed.candidate.number).toBe(42);
      expect(parsed.candidate.baseBranch).toBe("develop");
      expect(parsed.candidate.headBranch).toBe("feat/ega-766");
      expect(parsed.candidate.state).toBe("open");
    }
  });

  it("refuses a claim that contradicts itself", () => {
    expect(parsePullRequestCandidate({
      url: "https://github.com/EGA-BUILDS/helm/pull/42",
      number: 43,
    })).toEqual({ ok: false, reason: "candidate_inconsistent" });
    expect(parsePullRequestCandidate({
      url: "https://github.com/EGA-BUILDS/helm/pull/42",
      repository: "someone-else/helm",
    })).toEqual({ ok: false, reason: "candidate_inconsistent" });
  });

  it("refuses a claim whose number is not a number", () => {
    expect(parsePullRequestCandidate({ number: "forty-two" })).toEqual({
      ok: false,
      reason: "malformed_pr_number",
    });
    expect(parsePullRequestCandidate({ number: 0 })).toEqual({
      ok: false,
      reason: "malformed_pr_number",
    });
  });

  it("refuses a forged URL hidden in an ordinary claim field", () => {
    expect(parsePullRequestCandidate({
      number: 42,
      url: "https://evil.example.com/pull/42",
    })).toEqual({ ok: false, reason: "non_github_url" });
    expect(parsePullRequestCandidate({
      number: 42,
      link: "https://evil.example.com/pull/42",
    })).toEqual({ ok: false, reason: "non_github_url" });
  });
});

describe("EGA-766 no pull request", () => {
  it("reports no pull request when T3 claims none", () => {
    for (const candidate of [null, undefined, {}]) {
      expect(decide(candidate, found(githubPullRequest()))).toEqual({ status: "no_pr" });
    }
  });

  it("does not ask GitHub anything when there is no claim", () => {
    expect(screenPullRequestClaim({ candidate: null, identity })).toEqual({ kind: "no_pr" });
  });
});

describe("EGA-766 forged and unbound claims", () => {
  it("refuses a non-GitHub host with a specific reason", () => {
    const result = decide({ url: "https://evil.example.com/EGA-BUILDS/helm/pull/42" }, found(githubPullRequest()));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "non_github_url" });
  });

  it("refuses a malformed pull-request number with a specific reason", () => {
    const result = decide({ url: "https://github.com/EGA-BUILDS/helm/pull/abc" }, found(githubPullRequest()));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "malformed_pr_number" });
  });

  it("refuses a claim that names a different repository", () => {
    const result = decide(
      { url: "https://github.com/someone-else/helm/pull/42" },
      found(githubPullRequest()),
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "repository_mismatch" });
  });

  it("refuses a claim that names no repository at all", () => {
    const result = decide({ number: 42 }, found(githubPullRequest()));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "repository_not_identified" });
  });

  it("refuses a claim when no authorized identity could be resolved", () => {
    const result = decide(
      { url: "https://github.com/EGA-BUILDS/helm/pull/42" },
      found(githubPullRequest()),
      { identity: null },
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "repository_not_identified" });
  });

  it("refuses a claim when the two authorized sources disagree", () => {
    const result = decide(
      { url: "https://github.com/EGA-BUILDS/helm/pull/42" },
      found(githubPullRequest()),
      { identityConflict: true },
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "repository_mismatch" });
  });

  it("never turns a forged claim into a verified state, whatever GitHub says", () => {
    for (const candidate of [
      { url: "https://evil.example.com/EGA-BUILDS/helm/pull/42" },
      { url: "https://github.com/EGA-BUILDS/helm/pull/abc" },
      { url: "https://github.com/someone-else/helm/pull/42" },
      { number: 42 },
    ]) {
      const result = decide(candidate, found(githubPullRequest()));
      expect(result.status).not.toBe("verified_open");
      expect(result.status).not.toBe("verified_closed");
      expect(result.status).not.toBe("verified_merged");
    }
  });
});

describe("EGA-766 authoritative states", () => {
  const candidate = { url: "https://github.com/EGA-BUILDS/helm/pull/42", number: 42 };

  it("reports a verified open pull request", () => {
    const result = decide(candidate, found(githubPullRequest({ state: "open" })));
    expect(result.status).toBe("verified_open");
    if (result.status !== "verified_open") throw new Error("unreachable");
    expect(result.pullRequest.url).toBe("https://github.com/EGA-BUILDS/helm/pull/42");
    expect(result.pullRequest.baseBranch).toBe("develop");
    expect(result.pullRequest.headBranch).toBe("feat/ega-766");
  });

  it("reports a verified closed pull request", () => {
    const result = decide(candidate, found(githubPullRequest({ state: "closed", merged: false })));
    expect(result.status).toBe("verified_closed");
  });

  it("reports a verified merged pull request, distinctly from closed", () => {
    const result = decide(candidate, found(githubPullRequest({
      state: "closed",
      merged: true,
      mergedAt: "2026-10-20T10:00:00.000Z",
    })));
    expect(result.status).toBe("verified_merged");
    if (result.status !== "verified_merged") throw new Error("unreachable");
    expect(result.pullRequest.mergedAt).toBe("2026-10-20T10:00:00.000Z");
  });

  it("refuses a claim whose number disagrees with the authoritative response", () => {
    const result = decide(candidate, found(githubPullRequest({ number: 43 })));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "number_mismatch" });
  });

  it("refuses a claim whose target branch disagrees with the authoritative response", () => {
    const result = decide(
      { ...candidate, baseBranch: "main" },
      found(githubPullRequest({ baseRef: "develop" })),
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "base_branch_mismatch" });
  });

  it("refuses a pull request whose target branch is not the authorized target branch", () => {
    const result = decide(candidate, found(githubPullRequest({ baseRef: "main" })), {
      expectedBaseBranch: "develop",
    });
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "base_branch_mismatch" });
  });

  it("refuses a claim whose head branch disagrees with the authoritative response", () => {
    const result = decide(
      { ...candidate, headBranch: "feat/somewhere-else" },
      found(githubPullRequest({ headRef: "feat/ega-766" })),
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "head_branch_mismatch" });
  });

  it("refuses a claim whose state disagrees with the authoritative response", () => {
    const result = decide(
      { ...candidate, state: "merged" },
      found(githubPullRequest({ state: "open", merged: false })),
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "state_mismatch" });
  });

  it("refuses a pull request that really lives in another repository", () => {
    const result = decide(candidate, found(githubPullRequest({ baseRepository: "someone-else/helm" })));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "repository_mismatch" });
  });

  it("refuses a pull request whose GitHub URL points somewhere else", () => {
    const result = decide(candidate, found(githubPullRequest({
      htmlUrl: "https://github.com/someone-else/helm/pull/42",
    })));
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "url_mismatch" });
  });

  it("accepts a pull request from a fork: only the base repository is binding", () => {
    const result = decide(candidate, found(githubPullRequest({
      headRepository: "contributor/helm",
    })));
    expect(result.status).toBe("verified_open");
    if (result.status !== "verified_open") throw new Error("unreachable");
    expect(result.pullRequest.headRepository).toBe("contributor/helm");
  });

  it("reports a claim the authoritative source does not know as unverified", () => {
    const result = decide(candidate, { kind: "not_found" });
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "pull_request_not_found" });
  });
});

describe("EGA-766 verification unavailable", () => {
  const candidate = { url: "https://github.com/EGA-BUILDS/helm/pull/42", number: 42 };

  it("reports no credential as unavailable, never as verified", () => {
    const result = decide(candidate, { kind: "unavailable", reason: "no_credential" });
    expect(result.status).toBe("verification_unavailable");
    expect(result).toMatchObject({ reason: "no_credential" });
  });

  it("reports a transport failure as unavailable", () => {
    const result = decide(candidate, { kind: "unavailable", reason: "transport_failure" });
    expect(result.status).toBe("verification_unavailable");
    expect(result).toMatchObject({ reason: "transport_failure" });
  });

  it("keeps a forged claim forged even when GitHub is unreachable", () => {
    const result = decide(
      { url: "https://evil.example.com/EGA-BUILDS/helm/pull/42" },
      { kind: "unavailable", reason: "transport_failure" },
    );
    expect(result.status).toBe("unverified_report");
    expect(result).toMatchObject({ reason: "non_github_url" });
  });

  it("keeps the three non-verified states distinct", () => {
    const states = new Set([
      decide(null, { kind: "unavailable", reason: "no_credential" }).status,
      decide({ url: "https://evil.example.com/x/pull/1" }, found(githubPullRequest())).status,
      decide(candidate, { kind: "unavailable", reason: "no_credential" }).status,
    ]);
    expect(states).toEqual(new Set(["no_pr", "unverified_report", "verification_unavailable"]));
  });
});

describe("EGA-766 owner review status", () => {
  const candidate = { url: "https://github.com/EGA-BUILDS/helm/pull/42", number: 42 };

  it("does not report approval when the evidence carries no review decision", () => {
    const result = decide(candidate, found(githubPullRequest({ reviewDecision: null })));
    expect(result.status).toBe("verified_open");
    if (result.status !== "verified_open") throw new Error("unreachable");
    expect(result.review.status).toBe("unknown");
    expect(result.readiness).toBe("unknown");
  });

  it("does not report approval for a merged pull request without a review decision", () => {
    const result = decide(candidate, found(githubPullRequest({
      state: "closed",
      merged: true,
      reviewDecision: null,
    })));
    expect(result.status).toBe("verified_merged");
    if (result.status !== "verified_merged") throw new Error("unreachable");
    expect(result.review.status).toBe("unknown");
  });

  it("reports the review decision the authoritative source gave", () => {
    const result = decide(candidate, found(githubPullRequest({ reviewDecision: "CHANGES_REQUESTED" })));
    expect(result.status).toBe("verified_open");
    if (result.status !== "verified_open") throw new Error("unreachable");
    expect(result.review).toEqual({ status: "changes_requested", source: "github" });
    expect(result.readiness).toBe("unknown");
  });

  it("reports merge readiness only with approval AND a clean mergeable state", () => {
    const ready = decide(candidate, found(githubPullRequest({
      reviewDecision: "APPROVED",
      mergeableState: "clean",
    })));
    expect(ready.status).toBe("verified_open");
    if (ready.status !== "verified_open") throw new Error("unreachable");
    expect(ready.review.status).toBe("approved");
    expect(ready.readiness).toBe("ready_to_merge");

    const blocked = decide(candidate, found(githubPullRequest({
      reviewDecision: "APPROVED",
      mergeableState: "blocked",
    })));
    expect(blocked.status).toBe("verified_open");
    if (blocked.status !== "verified_open") throw new Error("unreachable");
    expect(blocked.readiness).toBe("unknown");

    const draft = decide(candidate, found(githubPullRequest({
      reviewDecision: "APPROVED",
      mergeableState: "clean",
      isDraft: true,
    })));
    expect(draft.status).toBe("verified_open");
    if (draft.status !== "verified_open") throw new Error("unreachable");
    expect(draft.readiness).toBe("unknown");
  });
});

describe("EGA-766 authoritative response normalization", () => {
  it("refuses a payload that is not a pull request", () => {
    expect(normalizeGitHubPullRequest(null)).toBeNull();
    expect(normalizeGitHubPullRequest({ message: "Not Found" })).toBeNull();
    expect(normalizeGitHubPullRequest({ number: 42, state: "open" })).toBeNull();
    expect(normalizeGitHubPullRequest({
      number: 42,
      state: "open",
      head: { ref: "feat/ega-766" },
    })).toBeNull();
  });

  it("reads a pull request payload", () => {
    const normalized = normalizeGitHubPullRequest({
      number: 42,
      state: "open",
      merged: false,
      draft: false,
      html_url: "https://github.com/EGA-BUILDS/helm/pull/42",
      base: { ref: "develop", repo: { full_name: "EGA-BUILDS/helm" } },
      head: { ref: "feat/ega-766", repo: { full_name: "EGA-BUILDS/helm" } },
      review_decision: "APPROVED",
      mergeable_state: "clean",
    });
    expect(normalized?.number).toBe(42);
    expect(normalized?.baseRepository).toBe("EGA-BUILDS/helm");
    expect(normalized?.reviewDecision).toBe("APPROVED");
    expect(normalized?.mergeableState).toBe("clean");
  });
});

describe("EGA-766 read-only GitHub client", () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const result = handler(url, init);
      const headers = new Map(Object.entries(result.headers ?? {}));
      return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => result.body,
      } as unknown as Response;
    };
    return { calls, fetchImpl };
  }

  it("issues exactly one GET and never a write", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
      status: 200,
      body: {
        number: 42,
        state: "open",
        merged: false,
        base: { ref: "develop", repo: { full_name: "EGA-BUILDS/helm" } },
        head: { ref: "feat/ega-766", repo: { full_name: "EGA-BUILDS/helm" } },
      },
    }));
    const lookup = await requestGitHubPullRequest({
      owner: "EGA-BUILDS",
      name: "helm",
      number: 42,
      token: "stub-token",
      fetchImpl,
    });
    expect(lookup.kind).toBe("found");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/EGA-BUILDS/helm/pulls/42");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("maps a 404 onto a refuted claim, not onto an unavailable verification", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404 }));
    const lookup = await requestGitHubPullRequest({
      owner: "EGA-BUILDS",
      name: "helm",
      number: 42,
      token: "stub-token",
      fetchImpl,
    });
    expect(lookup).toEqual({ kind: "not_found" });
  });

  it("maps a rejected credential and a rate limit onto unavailable", async () => {
    const unauthorized = stubFetch(() => ({ status: 401 }));
    expect(await requestGitHubPullRequest({
      owner: "EGA-BUILDS", name: "helm", number: 42, token: "stub-token", fetchImpl: unauthorized.fetchImpl,
    })).toEqual({ kind: "unavailable", reason: "unauthorized" });

    const limited = stubFetch(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect(await requestGitHubPullRequest({
      owner: "EGA-BUILDS", name: "helm", number: 42, token: "stub-token", fetchImpl: limited.fetchImpl,
    })).toEqual({ kind: "unavailable", reason: "rate_limited" });
  });

  it("maps a transport failure onto unavailable", async () => {
    const failing = async () => {
      throw new Error("network down");
    };
    expect(await requestGitHubPullRequest({
      owner: "EGA-BUILDS", name: "helm", number: 42, token: "stub-token", fetchImpl: failing,
    })).toEqual({ kind: "unavailable", reason: "transport_failure" });
  });

  it("maps an unreadable 200 body onto unavailable, never onto a verified state", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: { message: "unexpected" } }));
    expect(await requestGitHubPullRequest({
      owner: "EGA-BUILDS", name: "helm", number: 42, token: "stub-token", fetchImpl,
    })).toEqual({ kind: "unavailable", reason: "unexpected_response" });
  });
});
