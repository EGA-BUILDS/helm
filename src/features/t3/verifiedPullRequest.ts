/**
 * Owner-facing projection of a verified pull request (EGA-766).
 *
 * This module is the boundary between the verification state machine
 * (`convex/lib/verifiedPullRequest.ts`) and the dashboard. It owns four
 * rules:
 *
 *  1. **Only a verified state may produce a link.** The URL is re-validated
 *     here — not trusted from the payload — and it must resolve to exactly
 *     the repository and pull-request number Helm verified. An unverified or
 *     unavailable state never yields an `href`, so a forged claim can never
 *     become a clickable link.
 *  2. **Review status is shown only when the authoritative source said so.**
 *     An absent review decision reads as "unknown", which is rendered as no
 *     review line at all — never as "approved" and never as "ready to merge".
 *  3. **Each state says something different.** `no_pr`, `unverified_report`,
 *     `verified_open`, `verified_closed`, `verified_merged` and
 *     `verification_unavailable` are rendered as six distinct outcomes.
 *  4. **The repository identity's provenance is disclosed.** When the
 *     identity came only from T3's own project record, the owner is told so:
 *     that is T3's assertion, not an operator-authorized fact.
 *
 * The types come from the shared verification core, so the browser and the
 * backend can never disagree about what a state means.
 */

import {
  parseGitHubPullRequestUrl,
  type MergeReadiness,
  type OwnerReviewStatus,
  type PullRequestVerification,
  type UnavailableReason,
  type UnverifiedReason,
} from "../../../convex/lib/verifiedPullRequest";

export type PullRequestReviewLabel = "approved" | "changes_requested" | "unknown";

export interface PullRequestPresentation {
  readonly kind: "no_pr" | "unverified" | "verified" | "unavailable";
  readonly title: string;
  readonly detail: string;
  /** The exact validated URL, or null. Never set for an unverified claim. */
  readonly href: string | null;
  readonly state: "open" | "closed" | "merged" | null;
  readonly review: PullRequestReviewLabel;
  readonly readiness: MergeReadiness;
  readonly reason: UnverifiedReason | UnavailableReason | null;
  /** `owner/name` of the repository the pull request was verified in. */
  readonly repository: string | null;
  /** The pull-request number, when one is known. */
  readonly number: number | null;
  /** A caveat the owner must see, or null. */
  readonly caveat: string | null;
}

/** Owner-facing explanation for each reason a claim was not corroborated. */
const unverifiedReasons: Record<UnverifiedReason, string> = {
  candidate_not_recognised: "T3 mentioned a pull request without a reference Helm could read. Nothing was verified.",
  candidate_inconsistent: "T3's pull-request details contradict each other, so nothing was verified.",
  non_github_url: "The reported pull-request link does not point at GitHub, so it was refused.",
  malformed_pr_url: "The reported pull-request link is not a GitHub pull request, so it was refused.",
  malformed_pr_number: "The reported pull-request number is not a number, so it was refused.",
  repository_not_identified: "Helm could not bind the reported pull request to this project's repository, so nothing was verified.",
  repository_mismatch: "The reported pull request belongs to a different repository than this project, so it was refused.",
  thread_not_bound: "This thread reports no branch, so Helm could not bind any pull request to it. Nothing was verified.",
  claim_missing_base_branch: "The report did not say which branch the pull request targets, so nothing was verified.",
  claim_missing_head_branch: "The report did not say which branch the pull request comes from, so nothing was verified.",
  claim_missing_state: "The report did not say what state the pull request is in, so nothing was verified.",
  number_mismatch: "GitHub answered with a different pull request than the one reported, so nothing was verified.",
  url_mismatch: "GitHub's own link for the pull request does not match this repository, so it was refused.",
  url_not_confirmed: "GitHub did not report a link for the pull request, so it could not be confirmed.",
  base_branch_mismatch: "The pull request targets a different branch than the one reported, so it was refused.",
  head_branch_mismatch: "The pull request does not come from this thread's branch, so it was refused.",
  state_mismatch: "The pull request is in a different state than the one reported, so it was refused.",
  pull_request_not_found: "GitHub has no pull request at that reference in this repository.",
};

/** Owner-facing explanation for each reason verification could not run. */
const unavailableReasons: Record<UnavailableReason, string> = {
  no_credential: "Helm has no GitHub read credential configured, so no pull-request state can be confirmed.",
  unauthorized: "GitHub rejected Helm's read credential, so no pull-request state can be confirmed.",
  rate_limited: "GitHub is rate-limiting Helm's read, so no pull-request state can be confirmed.",
  transport_failure: "Helm could not reach GitHub, so no pull-request state can be confirmed.",
  server_error: "GitHub reported a server error, so no pull-request state can be confirmed.",
  unexpected_response: "GitHub's answer could not be read, so no pull-request state can be confirmed.",
};

/**
 * The only URL Helm will render for a pull request.
 *
 * The URL is re-parsed here and must name exactly the repository and number
 * that were verified. A payload cannot smuggle a different link past this.
 */
export function pullRequestHref(verification: PullRequestVerification | null): string | null {
  if (!verification) return null;
  if (verification.status !== "verified_open" && verification.status !== "verified_closed" &&
      verification.status !== "verified_merged") {
    return null;
  }
  const pullRequest = verification.pullRequest;
  const parsed = parseGitHubPullRequestUrl(pullRequest.url);
  if (!parsed.ok) return null;
  if (parsed.value.owner.toLowerCase() !== pullRequest.owner.toLowerCase()) return null;
  if (parsed.value.name.toLowerCase() !== pullRequest.name.toLowerCase()) return null;
  if (parsed.value.number !== pullRequest.number) return null;
  return parsed.value.href;
}

/**
 * The review line, or null when the authoritative reviews carried no
 * decision. GitHub's pull-request endpoint does not report a review decision,
 * so this is derived from the reviews themselves and stays silent whenever
 * that evidence is absent.
 */
export function pullRequestReviewLabel(review: OwnerReviewStatus | null | undefined): string | null {
  if (!review || review.status === "unknown") return null;
  if (review.status === "approved") return "Approved by a reviewer";
  return "Changes requested by a reviewer";
}

/** Project a verification result onto what the owner is shown. */
export function presentPullRequest(verification: PullRequestVerification | null): PullRequestPresentation {
  if (!verification) {
    return {
      kind: "no_pr",
      title: "No pull request",
      detail: "No pull request is linked to this thread.",
      href: null,
      state: null,
      review: "unknown",
      readiness: "unknown",
      reason: null,
      repository: null,
      number: null,
      caveat: null,
    };
  }
  if (verification.status === "no_pr") {
    return {
      kind: "no_pr",
      title: "No pull request",
      detail: "No pull request is linked to this thread. A missing pull request does not mean the execution failed.",
      href: null,
      state: null,
      review: "unknown",
      readiness: "unknown",
      reason: null,
      repository: null,
      number: null,
      caveat: null,
    };
  }
  if (verification.status === "unverified_report") {
    return {
      kind: "unverified",
      title: "Reported pull request, not verified",
      detail: unverifiedReasons[verification.reason],
      href: null,
      state: null,
      review: "unknown",
      readiness: "unknown",
      reason: verification.reason,
      repository: verification.claimed?.owner && verification.claimed.name
        ? `${verification.claimed.owner}/${verification.claimed.name}`
        : null,
      number: verification.claimed?.number ?? null,
      caveat: null,
    };
  }
  if (verification.status === "verification_unavailable") {
    return {
      kind: "unavailable",
      title: "Pull request state unavailable",
      detail: unavailableReasons[verification.reason],
      href: null,
      state: null,
      review: "unknown",
      readiness: "unknown",
      reason: verification.reason,
      repository: null,
      number: null,
      caveat: null,
    };
  }

  const pullRequest = verification.pullRequest;
  const state = verification.status === "verified_merged"
    ? "merged"
    : verification.status === "verified_closed"
      ? "closed"
      : "open";
  const stateTitle = state === "merged" ? "Merged" : state === "closed" ? "Closed" : "Open";
  const branches = `${pullRequest.baseBranch} ← ${pullRequest.headBranch}`;
  const fork = pullRequest.headRepository && pullRequest.headRepository !== `${pullRequest.owner}/${pullRequest.name}`
    ? ` · from ${pullRequest.headRepository}`
    : "";
  return {
    kind: "verified",
    title: `${stateTitle} pull request #${pullRequest.number}`,
    detail: `${pullRequest.owner}/${pullRequest.name} · ${branches}${fork}`,
    href: pullRequestHref(verification),
    state,
    review: verification.review.status,
    readiness: verification.readiness,
    reason: null,
    repository: `${pullRequest.owner}/${pullRequest.name}`,
    number: pullRequest.number,
    // The identity came from T3's own project record, not from the operator
    // configuration. Say so: that is T3's assertion, and the owner should
    // know it is not an independently configured fact.
    caveat: pullRequest.identitySource === "t3_project"
      ? "Repository identity asserted by T3's project record — no operator-configured repository was set."
      : null,
  };
}
