import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerifiedPullRequestCard } from "./VerifiedPullRequestCard";
import type { PullRequestVerification } from "../../../convex/lib/verifiedPullRequest";

/**
 * EGA-766 — the pull-request card renders only what was proven.
 *
 * Rendered to static markup, so the assertions are about the markup the
 * owner actually receives: a link only for a verified pull request, and a
 * review line only when the authoritative source supplied a decision.
 */

function verified(overrides: {
  state?: "open" | "closed" | "merged";
  review?: "approved" | "changes_requested" | "review_required" | "unknown";
  url?: string;
} = {}): PullRequestVerification {
  const state = overrides.state ?? "open";
  const pullRequest = {
    number: 42,
    owner: "EGA-BUILDS",
    name: "helm",
    url: overrides.url ?? "https://github.com/EGA-BUILDS/helm/pull/42",
    baseBranch: "develop",
    headBranch: "feat/ega-766",
    headRepository: "EGA-BUILDS/helm",
    isDraft: false,
    mergedAt: null,
    observedAt: "2026-10-20T12:00:00.000Z",
  };
  const review = { status: overrides.review ?? "unknown", source: "github" as const };
  const readiness = "unknown" as const;
  if (state === "merged") return { status: "verified_merged", pullRequest, review, readiness };
  if (state === "closed") return { status: "verified_closed", pullRequest, review, readiness };
  return { status: "verified_open", pullRequest, review, readiness };
}

function render(verification: PullRequestVerification | null): string {
  return renderToStaticMarkup(createElement(VerifiedPullRequestCard, { verification }));
}

describe("EGA-766 pull-request card", () => {
  it("renders no pull request without a link", () => {
    const html = render({ status: "no_pr" });
    expect(html).toContain("No pull request");
    expect(html).not.toContain("data-role=\"pull-request-link\"");
    expect(html).not.toContain("<a ");
  });

  it("renders an unverified report without a link", () => {
    const html = render({
      status: "unverified_report",
      reason: "non_github_url",
      claimed: { number: 42, owner: "EGA-BUILDS", name: "helm" },
    });
    expect(html).toContain("Reported pull request, not verified");
    expect(html).not.toContain("data-role=\"pull-request-link\"");
    expect(html).not.toContain("evil.example.com");
  });

  it("renders an unavailable verification without a link", () => {
    const html = render({ status: "verification_unavailable", reason: "no_credential" });
    expect(html).toContain("Pull request state unavailable");
    expect(html).not.toContain("data-role=\"pull-request-link\"");
  });

  it("links a verified pull request to the exact validated URL", () => {
    const html = render(verified());
    expect(html).toContain('href="https://github.com/EGA-BUILDS/helm/pull/42"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain("Open pull request #42");
  });

  it("renders no link when a verified payload carries a foreign URL", () => {
    const html = render(verified({ url: "https://evil.example.com/pull/42" }));
    expect(html).not.toContain("data-role=\"pull-request-link\"");
    expect(html).not.toContain("evil.example.com");
  });

  it("renders a review line only when the source gave a decision", () => {
    expect(render(verified({ review: "unknown" }))).not.toContain("data-role=\"review\"");
    const approved = render(verified({ review: "approved" }));
    expect(approved).toContain("Approved by a reviewer");
    expect(approved).toContain('data-review="approved"');
  });

  it("distinguishes the three verified states", () => {
    expect(render(verified({ state: "open" }))).toContain("Open pull request #42");
    expect(render(verified({ state: "closed" }))).toContain("Closed pull request #42");
    expect(render(verified({ state: "merged" }))).toContain("Merged pull request #42");
  });
});
