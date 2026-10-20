import { describe, expect, it } from "vitest";
import {
  presentPullRequest,
  pullRequestHref,
  pullRequestReviewLabel,
} from "./verifiedPullRequest";
import type { PullRequestVerification } from "../../../convex/lib/verifiedPullRequest";

/**
 * EGA-766 — the owner-facing projection of a verified pull request.
 *
 * The rules under test: only a verified state produces a link, the link is
 * the exact validated GitHub URL, an unverified claim never becomes a
 * clickable link, a review status is only ever shown when the authoritative
 * source supplied one, and the provenance of the repository identity is
 * disclosed.
 */

const verified = (overrides: Partial<{
  state: "open" | "closed" | "merged";
  review: "approved" | "changes_requested" | "unknown";
  readiness: "ready_to_merge" | "unknown";
  url: string;
  number: number;
  owner: string;
  name: string;
  identitySource: "operator_configuration" | "t3_project";
  threadId: string;
}> = {}): PullRequestVerification => {
  const state = overrides.state ?? "open";
  const number = overrides.number ?? 42;
  const owner = overrides.owner ?? "EGA-BUILDS";
  const name = overrides.name ?? "helm";
  const pullRequest = {
    number,
    owner,
    name,
    url: overrides.url ?? `https://github.com/${owner}/${name}/pull/${number}`,
    baseBranch: "develop",
    headBranch: "feat/ega-766",
    headRepository: `${owner}/${name}`,
    isDraft: false,
    mergedAt: state === "merged" ? "2026-10-20T10:00:00.000Z" : null,
    identitySource: overrides.identitySource ?? "t3_project",
    threadId: overrides.threadId ?? "mcp:58ee0336-b6be-489c-8462-3bc18246e5b3",
    observedAt: "2026-10-20T12:00:00.000Z",
  };
  const review = { status: overrides.review ?? "unknown", source: "github" as const };
  const readiness = overrides.readiness ?? "unknown";
  if (state === "merged") return { status: "verified_merged", pullRequest, review, readiness };
  if (state === "closed") return { status: "verified_closed", pullRequest, review, readiness };
  return { status: "verified_open", pullRequest, review, readiness };
};

describe("EGA-766 pull-request presentation", () => {
  it("shows no pull request as its own outcome", () => {
    const presentation = presentPullRequest({ status: "no_pr" });
    expect(presentation.kind).toBe("no_pr");
    expect(presentation.href).toBeNull();
    expect(presentation.title).toMatch(/no pull request/i);
  });

  it("shows an unverified report without a link", () => {
    const presentation = presentPullRequest({
      status: "unverified_report",
      reason: "non_github_url",
      claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
    });
    expect(presentation.kind).toBe("unverified");
    expect(presentation.href).toBeNull();
    expect(presentation.detail).toMatch(/does not point at github/i);
  });

  it("explains an unbound thread in its own words", () => {
    const presentation = presentPullRequest({
      status: "unverified_report",
      reason: "thread_not_bound",
      claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
    });
    expect(presentation.kind).toBe("unverified");
    expect(presentation.detail).toMatch(/no branch/i);
    expect(presentation.href).toBeNull();
  });

  it("explains an incomplete claim in its own words", () => {
    for (const reason of ["claim_missing_base_branch", "claim_missing_head_branch", "claim_missing_state"] as const) {
      const presentation = presentPullRequest({
        status: "unverified_report",
        reason,
        claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
      });
      expect(presentation.kind).toBe("unverified");
      expect(presentation.detail.length).toBeGreaterThan(0);
      expect(presentation.href).toBeNull();
    }
  });

  it("shows an unavailable verification without a link", () => {
    const presentation = presentPullRequest({ status: "verification_unavailable", reason: "no_credential" });
    expect(presentation.kind).toBe("unavailable");
    expect(presentation.href).toBeNull();
    expect(presentation.detail).toMatch(/credential/i);
  });

  it("shows each verified state distinctly", () => {
    expect(presentPullRequest(verified({ state: "open" })).title).toMatch(/open pull request #42/i);
    expect(presentPullRequest(verified({ state: "closed" })).title).toMatch(/closed pull request #42/i);
    expect(presentPullRequest(verified({ state: "merged" })).title).toMatch(/merged pull request #42/i);
  });

  it("links a verified pull request to the exact validated URL", () => {
    const presentation = presentPullRequest(verified());
    expect(presentation.href).toBe("https://github.com/EGA-BUILDS/helm/pull/42");
  });

  it("refuses to link a verified payload whose URL points elsewhere", () => {
    const presentation = presentPullRequest(verified({ url: "https://evil.example.com/pull/42" }));
    expect(presentation.href).toBeNull();
  });

  it("refuses to link a verified payload whose URL names another pull request", () => {
    const presentation = presentPullRequest(verified({ url: "https://github.com/EGA-BUILDS/helm/pull/43" }));
    expect(presentation.href).toBeNull();
  });

  it("refuses to link an unverified claim", () => {
    expect(pullRequestHref({
      status: "unverified_report",
      reason: "non_github_url",
      claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
    })).toBeNull();
    expect(pullRequestHref({ status: "verification_unavailable", reason: "no_credential" })).toBeNull();
    expect(pullRequestHref({ status: "no_pr" })).toBeNull();
    expect(pullRequestHref(null)).toBeNull();
  });

  it("shows no review line when the authoritative source gave no decision", () => {
    expect(pullRequestReviewLabel({ status: "unknown", source: "github" })).toBeNull();
    expect(pullRequestReviewLabel(null)).toBeNull();
    expect(presentPullRequest(verified({ review: "unknown" })).review).toBe("unknown");
  });

  it("shows the review decision the authoritative source gave", () => {
    expect(pullRequestReviewLabel({ status: "approved", source: "github" })).toMatch(/approved/i);
    expect(pullRequestReviewLabel({ status: "changes_requested", source: "github" })).toMatch(/changes requested/i);
  });

  it("never reports merge readiness without approval", () => {
    const presentation = presentPullRequest(verified({ review: "unknown", readiness: "unknown" }));
    expect(presentation.readiness).toBe("unknown");
    expect(presentation.detail).not.toMatch(/ready to merge/i);
  });

  it("discloses that T3 alone asserted the repository identity", () => {
    const fromT3 = presentPullRequest(verified({ identitySource: "t3_project" }));
    expect(fromT3.caveat).toMatch(/t3/i);
    expect(fromT3.caveat).toMatch(/operator/i);

    const fromOperator = presentPullRequest(verified({ identitySource: "operator_configuration" }));
    expect(fromOperator.caveat).toBeNull();
  });
});
