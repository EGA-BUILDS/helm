/**
 * Verified pull-request state for native T3 execution (EGA-766).
 *
 * ## The rule this module exists to enforce
 *
 * Native T3 surfaces `thread.linkedPullRequest` as an arbitrary
 * `record(string, any)`. That record is a **claim**: it is produced on the T3
 * side and may contain anything, including a URL forged to look like GitHub.
 * It is never evidence. An agent saying "I opened PR #42" in prose is a claim
 * too, and Helm never renders it as a verified pull request.
 *
 * A pull request is only `verified_*` when an **authoritative** read of the
 * Git host says so, and only after the claim has been bound to a repository
 * identity that Helm resolved from an authorized source. Everything else is
 * reported as exactly what it is: `no_pr`, `unverified_report`, or
 * `verification_unavailable`. Those three are never collapsed into each other
 * and never into a verified state.
 *
 * ## Shape of the module
 *
 * This file is deliberately free of Node built-ins, environment reads and
 * framework imports, so the *same* decision code runs in the Convex backend
 * and in the browser. It contains:
 *
 *  - parsers for the untrusted candidate, the authorized repository identity
 *    and the authoritative GitHub response;
 *  - `screenPullRequestClaim`, the part of the state machine that is settled
 *    without asking GitHub (no claim, a forged claim, a claim that cannot be
 *    bound to the authorized repository);
 *  - `decidePullRequestVerification`, the complete pure state machine;
 *  - `requestGitHubPullRequest`, a read-only GitHub client that takes its
 *    `fetch` implementation and its credential as arguments, so it can be
 *    driven by a stub in tests and never reads a secret by itself.
 *
 * There is **no** Git write path anywhere in this file: the client only ever
 * issues `GET` against `api.github.com`, and `convex/verifiedPullRequest.test.ts`
 * asserts that from source.
 */

/** The only Git host Helm will ever verify a pull request against. */
export const GITHUB_HOST = "github.com";
/** Read-only GitHub REST base. Overridable only for tests, never by callers. */
export const GITHUB_API_BASE = "https://api.github.com";
/** Longest accepted claim text. Keeps parsing bounded on untrusted input. */
export const MAX_CLAIM_LENGTH = 2048;
/** Longest accepted repository identity. */
export const MAX_IDENTITY_LENGTH = 512;

/* -------------------------------------------------------------------------- */
/* Repository identity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A repository identity Helm resolved from an authorized source.
 *
 * `source` records WHICH authorized source produced it, because the two
 * sources are not interchangeable: the T3 project read is owner-scoped and
 * per-project, the operator configuration is deployment-wide. When both exist
 * and disagree, Helm refuses to bind the claim to either.
 */
export interface RepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly source: "t3_project" | "operator_configuration";
}

const OWNER_NAME = /^[A-Za-z0-9._-]{1,100}$/u;

function validOwnerName(value: string): boolean {
  return OWNER_NAME.test(value);
}

/** Case-insensitive comparison: GitHub owner and name are case-insensitive. */
export function sameRepository(left: { owner: string; name: string }, right: { owner: string; name: string }): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase();
}

/**
 * Parse a repository identity written in any of the shapes Helm has seen.
 *
 * Accepted: `owner/name`, `github.com/owner/name`, `github:owner/name`,
 * `https://github.com/owner/name`, `git@github.com:owner/name.git`,
 * `ssh://git@github.com/owner/name.git`.
 *
 * Anything else — a local path, a UUID, a URL on another host — is REFUSED
 * (returns `null`), because Helm must not guess which repository a claim
 * belongs to.
 */
export function parseRepositoryIdentity(
  raw: unknown,
  source: RepositoryIdentity["source"] = "t3_project",
): RepositoryIdentity | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  const normalized = trimmed
    .replace(/^git\+/iu, "")
    .replace(/^ssh:\/\//iu, "")
    .replace(/^https?:\/\//iu, "")
    .replace(/^git@/iu, "")
    .replace(/^github\.com:/iu, "")
    .replace(/^github:/iu, "")
    .replace(/\.git$/iu, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const pair = parts.length === 3 && parts[0]!.toLowerCase() === GITHUB_HOST
    ? { owner: parts[1]!, name: parts[2]! }
    : parts.length === 2
      ? { owner: parts[0]!, name: parts[1]! }
      : null;
  if (!pair) return null;
  if (!validOwnerName(pair.owner) || !validOwnerName(pair.name)) return null;
  return { owner: pair.owner, name: pair.name, source };
}

/**
 * Reconcile two authorized identities.
 *
 * A T3 project identity and an operator-configured identity that disagree
 * cannot both be right, so the result is a conflict rather than a choice.
 */
export function resolveRepositoryIdentity(input: {
  readonly t3ProjectIdentity: unknown;
  readonly operatorConfigured: unknown;
}): { readonly identity: RepositoryIdentity | null; readonly conflict: boolean } {
  const t3 = parseRepositoryIdentity(input.t3ProjectIdentity, "t3_project");
  const configured = parseRepositoryIdentity(input.operatorConfigured, "operator_configuration");
  if (t3 && configured && !sameRepository(t3, configured)) return { identity: null, conflict: true };
  return { identity: t3 ?? configured, conflict: false };
}

/* -------------------------------------------------------------------------- */
/* GitHub pull-request URLs                                                     */
/* -------------------------------------------------------------------------- */

/** Why a claimed pull-request URL was refused. */
export type PullRequestUrlRejection = "non_github_url" | "malformed_pr_url" | "malformed_pr_number";

export interface GitHubPullRequestUrl {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  /** Canonical, validated `https://github.com/owner/name/pull/number` URL. */
  readonly href: string;
}

/** Build the one canonical URL Helm is willing to render for a pull request. */
export function githubPullRequestUrl(owner: string, name: string, number: number): string {
  return `https://${GITHUB_HOST}/${owner}/${name}/pull/${number}`;
}

/**
 * Parse a claimed pull-request URL.
 *
 * This is the anti-forgery gate. A URL is accepted only when it is HTTPS, has
 * no embedded credentials, points at `github.com`, and has the exact
 * `/{owner}/{name}/pull/{number}` path shape. Everything else is refused with
 * a specific reason so the owner is told WHAT is wrong.
 */
export function parseGitHubPullRequestUrl(raw: unknown):
  | { readonly ok: true; readonly value: GitHubPullRequestUrl }
  | { readonly ok: false; readonly reason: PullRequestUrlRejection } {
  if (typeof raw !== "string") return { ok: false, reason: "malformed_pr_url" };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLAIM_LENGTH) return { ok: false, reason: "malformed_pr_url" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "malformed_pr_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "malformed_pr_url" };
  if (url.username || url.password) return { ok: false, reason: "malformed_pr_url" };
  const host = url.hostname.toLowerCase();
  if (host !== GITHUB_HOST && host !== `www.${GITHUB_HOST}`) return { ok: false, reason: "non_github_url" };
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 4) return { ok: false, reason: "malformed_pr_url" };
  const owner = segments[0]!;
  const name = segments[1]!;
  if (!validOwnerName(owner) || !validOwnerName(name)) return { ok: false, reason: "malformed_pr_url" };
  if (segments[2]!.toLowerCase() !== "pull") return { ok: false, reason: "malformed_pr_url" };
  const rawNumber = segments[3]!;
  if (!/^[0-9]{1,9}$/u.test(rawNumber)) return { ok: false, reason: "malformed_pr_number" };
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, reason: "malformed_pr_number" };
  return { ok: true, value: { owner, name, number, href: githubPullRequestUrl(owner, name, number) } };
}

/* -------------------------------------------------------------------------- */
/* The candidate (untrusted T3 claim)                                          */
/* -------------------------------------------------------------------------- */

/** Why a claim could not be read as a pull-request reference. */
export type CandidateRejection =
  | "candidate_not_recognised"
  | "candidate_inconsistent"
  | "non_github_url"
  | "malformed_pr_url"
  | "malformed_pr_number";

export interface PullRequestCandidate {
  readonly number: number | null;
  readonly owner: string | null;
  readonly name: string | null;
  readonly baseBranch: string | null;
  readonly headBranch: string | null;
  readonly state: string | null;
}

const URL_KEYS = [
  "url", "htmlUrl", "html_url", "webUrl", "web_url", "permalink", "link",
  "prUrl", "pullRequestUrl", "pull_request_url",
] as const;
const NUMBER_KEYS = [
  "number", "prNumber", "pr_number", "pullRequestNumber", "pull_request_number",
] as const;
const REPOSITORY_KEYS = [
  "repository", "repo", "repositoryFullName", "repository_full_name", "fullName", "full_name",
] as const;
const OWNER_KEYS = ["owner", "repositoryOwner", "ownerLogin", "owner_login"] as const;
const NAME_KEYS = ["name", "repositoryName", "repoName", "repo_name"] as const;
const BASE_BRANCH_KEYS = [
  "baseBranch", "base_branch", "targetBranch", "target_branch", "baseRef", "base_ref", "base", "target",
] as const;
const HEAD_BRANCH_KEYS = [
  "headBranch", "head_branch", "sourceBranch", "source_branch", "headRef", "head_ref", "head",
] as const;
const STATE_KEYS = ["state", "status", "prState", "pr_state"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CLAIM_LENGTH) {
      return value.trim();
    }
  }
  return null;
}

/** The repository a claim names, as raw `owner/name` text. */
function claimedRepositoryText(source: Record<string, unknown>): string | null {
  for (const key of REPOSITORY_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (isRecord(value)) {
      const nested = value.full_name ?? value.fullName ?? value.canonicalKey ?? value.canonical_key;
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
      const owner = value.owner ?? value.ownerLogin;
      const name = value.name ?? value.repoName;
      if (typeof owner === "string" && typeof name === "string" && owner.trim() && name.trim()) {
        return `${owner.trim()}/${name.trim()}`;
      }
    }
  }
  const owner = stringField(source, OWNER_KEYS);
  const name = stringField(source, NAME_KEYS);
  if (owner && name) return `${owner}/${name}`;
  return null;
}

/**
 * Every URL-ish top-level string in the claim. A forged URL cannot hide.
 *
 * A known URL field is always read as a URL claim, so a forged link in `url`
 * is refused rather than skipped. Any OTHER top-level string is read as a URL
 * claim only when it *starts* with a scheme, so prose that merely mentions a
 * link is not mistaken for one — prose is not a link either way.
 */
function claimedUrlStrings(source: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of URL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) found.push(value.trim());
  }
  for (const [key, value] of Object.entries(source)) {
    if ((URL_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(value.trim())) found.push(value.trim());
  }
  return found;
}

/**
 * Read an untrusted `linkedPullRequest` record as a pull-request reference.
 *
 * The shape of T3's record is not published, so the parser accepts a bounded
 * set of field aliases and reads a URL out of ANY top-level string that looks
 * like one. A URL that is not a GitHub pull-request URL is REFUSED, never
 * skipped: a forged link must fail loudly, not silently fall through to some
 * other field.
 */
export function parsePullRequestCandidate(raw: unknown):
  | { readonly ok: true; readonly candidate: PullRequestCandidate }
  | { readonly ok: false; readonly reason: CandidateRejection } {
  if (!isRecord(raw)) return { ok: false, reason: "candidate_not_recognised" };

  const urlStrings = claimedUrlStrings(raw);
  let urlValue: GitHubPullRequestUrl | null = null;
  for (const candidateUrl of urlStrings) {
    const parsed = parseGitHubPullRequestUrl(candidateUrl);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (urlValue && !sameRepository(urlValue, parsed.value)) return { ok: false, reason: "candidate_inconsistent" };
    if (urlValue && urlValue.number !== parsed.value.number) return { ok: false, reason: "candidate_inconsistent" };
    urlValue = parsed.value;
  }

  let number: number | null = urlValue?.number ?? null;
  for (const key of NUMBER_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    let parsedNumber: number | null = null;
    if (typeof value === "number") parsedNumber = value;
    else if (typeof value === "string" && /^[0-9]{1,9}$/u.test(value.trim())) parsedNumber = Number(value.trim());
    else return { ok: false, reason: "malformed_pr_number" };
    if (!Number.isSafeInteger(parsedNumber) || parsedNumber <= 0) return { ok: false, reason: "malformed_pr_number" };
    if (number !== null && number !== parsedNumber) return { ok: false, reason: "candidate_inconsistent" };
    number = parsedNumber;
  }

  let owner: string | null = urlValue?.owner ?? null;
  let name: string | null = urlValue?.name ?? null;
  const repositoryText = claimedRepositoryText(raw);
  if (repositoryText !== null) {
    const identity = parseRepositoryIdentity(repositoryText);
    if (!identity) return { ok: false, reason: "candidate_not_recognised" };
    if (owner !== null && name !== null && !sameRepository({ owner, name }, identity)) {
      return { ok: false, reason: "candidate_inconsistent" };
    }
    owner = identity.owner;
    name = identity.name;
  }

  if (number === null) return { ok: false, reason: "candidate_not_recognised" };

  return {
    ok: true,
    candidate: {
      number,
      owner,
      name,
      baseBranch: stringField(raw, BASE_BRANCH_KEYS),
      headBranch: stringField(raw, HEAD_BRANCH_KEYS),
      state: stringField(raw, STATE_KEYS),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The authoritative GitHub response                                            */
/* -------------------------------------------------------------------------- */

/** The review decision GitHub reports, or `null` when GitHub did not report one. */
export type GitHubReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface GitHubPullRequest {
  readonly number: number;
  /** `open` or `closed`. A merged pull request is reported by GitHub as closed. */
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly isDraft: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  /** `owner/name` of the repository the pull request targets. */
  readonly baseRepository: string;
  /** `owner/name` of the repository the pull request comes from. May be a fork. */
  readonly headRepository: string | null;
  /** GitHub's own canonical URL, when it reported one. */
  readonly htmlUrl: string | null;
  readonly reviewDecision: GitHubReviewDecision | null;
  readonly mergeableState: string | null;
}

function repositoryFullName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const fullName = value.full_name ?? value.fullName;
  if (typeof fullName !== "string") return null;
  const identity = parseRepositoryIdentity(fullName);
  return identity ? `${identity.owner}/${identity.name}` : null;
}

function reviewDecisionOf(value: unknown): GitHubReviewDecision | null {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") return value;
  return null;
}

/**
 * Normalize the authoritative GitHub payload.
 *
 * Returns `null` when the response cannot be read as a pull request at all.
 * A `null` here is never a verification: it becomes `verification_unavailable`.
 */
export function normalizeGitHubPullRequest(raw: unknown): GitHubPullRequest | null {
  if (!isRecord(raw)) return null;
  const number = raw.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  const state = raw.state;
  if (state !== "open" && state !== "closed") return null;
  const base = isRecord(raw.base) ? raw.base : null;
  const head = isRecord(raw.head) ? raw.head : null;
  if (!base || !head) return null;
  const baseRef = typeof base.ref === "string" ? base.ref : null;
  const headRef = typeof head.ref === "string" ? head.ref : null;
  if (!baseRef || !headRef) return null;
  const baseRepository = repositoryFullName(base.repo);
  if (!baseRepository) return null;
  const htmlUrl = typeof raw.html_url === "string" ? raw.html_url : null;
  return {
    number,
    state,
    merged: raw.merged === true,
    mergedAt: typeof raw.merged_at === "string" ? raw.merged_at : null,
    isDraft: raw.draft === true,
    baseRef,
    headRef,
    baseRepository,
    headRepository: repositoryFullName(head.repo),
    htmlUrl,
    reviewDecision: reviewDecisionOf(raw.review_decision),
    mergeableState: typeof raw.mergeable_state === "string" ? raw.mergeable_state : null,
  };
}

/** Why the authoritative read could not be performed. */
export type UnavailableReason =
  | "no_credential"
  | "unauthorized"
  | "rate_limited"
  | "transport_failure"
  | "server_error"
  | "unexpected_response";

/** The outcome of the authoritative read. */
export type GitHubLookup =
  | { readonly kind: "found"; readonly pullRequest: GitHubPullRequest }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason };

/* -------------------------------------------------------------------------- */
/* The state machine                                                            */
/* -------------------------------------------------------------------------- */

/** Why a claim could not be corroborated. Never a verified state. */
export type UnverifiedReason =
  | "candidate_not_recognised"
  | "candidate_inconsistent"
  | "non_github_url"
  | "malformed_pr_url"
  | "malformed_pr_number"
  | "repository_not_identified"
  | "repository_mismatch"
  | "number_mismatch"
  | "url_mismatch"
  | "base_branch_mismatch"
  | "head_branch_mismatch"
  | "state_mismatch"
  | "pull_request_not_found";

/** Owner-review status. Only ever derived from the authoritative response. */
export type OwnerReviewStatus =
  | { readonly status: "approved"; readonly source: "github" }
  | { readonly status: "changes_requested"; readonly source: "github" }
  | { readonly status: "review_required"; readonly source: "github" }
  | { readonly status: "unknown"; readonly source: "github" };

/** Merge readiness. Only ever derived from the authoritative response. */
export type MergeReadiness = "ready_to_merge" | "unknown";

/** A pull request the authoritative source confirmed. */
export interface VerifiedPullRequest {
  readonly number: number;
  readonly owner: string;
  readonly name: string;
  /** The exact, validated GitHub URL. The only URL Helm renders. */
  readonly url: string;
  /** The pull request's target branch, as GitHub reports it. */
  readonly baseBranch: string;
  /** The pull request's head branch, as GitHub reports it. */
  readonly headBranch: string;
  /** `owner/name` of the head repository. May be a fork of the base repository. */
  readonly headRepository: string | null;
  readonly isDraft: boolean;
  readonly mergedAt: string | null;
  /** When Helm observed the authoritative state. */
  readonly observedAt: string | null;
}

/** The claim Helm could not corroborate. Never rendered as a link. */
export interface ClaimedPullRequest {
  readonly number: number | null;
  readonly owner: string | null;
  readonly name: string | null;
}

/**
 * The complete, exhaustive outcome of a verification attempt.
 *
 * `verified_open`, `verified_closed` and `verified_merged` are three distinct
 * states on purpose: a merged pull request is closed, and collapsing the two
 * would misreport what happened.
 */
export type PullRequestVerification =
  | { readonly status: "no_pr" }
  | { readonly status: "unverified_report"; readonly reason: UnverifiedReason; readonly claimed: ClaimedPullRequest | null }
  | { readonly status: "verified_open"; readonly pullRequest: VerifiedPullRequest; readonly review: OwnerReviewStatus; readonly readiness: MergeReadiness }
  | { readonly status: "verified_closed"; readonly pullRequest: VerifiedPullRequest; readonly review: OwnerReviewStatus; readonly readiness: MergeReadiness }
  | { readonly status: "verified_merged"; readonly pullRequest: VerifiedPullRequest; readonly review: OwnerReviewStatus; readonly readiness: MergeReadiness }
  | { readonly status: "verification_unavailable"; readonly reason: UnavailableReason };

export interface PullRequestVerificationInput {
  /** The raw `linkedPullRequest` record from T3. A claim, never evidence. */
  readonly candidate: unknown;
  /** Repository identity resolved from an authorized source. */
  readonly identity: RepositoryIdentity | null;
  /** True when two authorized sources disagreed about the repository. */
  readonly identityConflict?: boolean;
  /** Optional authorized expectation for the pull request's target branch. */
  readonly expectedBaseBranch?: string | null;
  /** The authoritative read, or why it could not be performed. */
  readonly response: GitHubLookup;
  /** When the verification ran. */
  readonly observedAt?: string | null;
}

function unverified(reason: UnverifiedReason, claimed: ClaimedPullRequest | null = null): PullRequestVerification {
  return { status: "unverified_report", reason, claimed };
}

function claimedOf(candidate: PullRequestCandidate): ClaimedPullRequest {
  return { number: candidate.number, owner: candidate.owner, name: candidate.name };
}

/**
 * The pre-flight screen: everything Helm can decide WITHOUT asking GitHub.
 *
 * This is deliberately separate from the lookup so a caller knows whether a
 * network read is needed at all. A forged claim, an unbindable claim and a
 * conflicting repository identity are all settled here, before any request is
 * made — and they stay settled even when GitHub is unreachable.
 */
export type ClaimScreen =
  | { readonly kind: "no_pr" }
  | { readonly kind: "unverified"; readonly reason: UnverifiedReason; readonly claimed: ClaimedPullRequest | null }
  | { readonly kind: "needs_lookup"; readonly candidate: PullRequestCandidate };

export function screenPullRequestClaim(input: {
  readonly candidate: unknown;
  readonly identity: RepositoryIdentity | null;
  readonly identityConflict?: boolean;
}): ClaimScreen {
  const raw = input.candidate;
  const hasClaim = raw !== null && raw !== undefined && !(isRecord(raw) && Object.keys(raw).length === 0);
  if (!hasClaim) return { kind: "no_pr" };

  // Two authorized sources that disagree cannot both be right. Helm refuses
  // to bind the claim to either one.
  if (input.identityConflict) return { kind: "unverified", reason: "repository_mismatch", claimed: null };

  const parsed = parsePullRequestCandidate(raw);
  if (!parsed.ok) return { kind: "unverified", reason: parsed.reason, claimed: null };
  const candidate = parsed.candidate;

  if (!input.identity) return { kind: "unverified", reason: "repository_not_identified", claimed: claimedOf(candidate) };
  if (!candidate.owner || !candidate.name) {
    return { kind: "unverified", reason: "repository_not_identified", claimed: claimedOf(candidate) };
  }
  if (!sameRepository({ owner: candidate.owner, name: candidate.name }, input.identity)) {
    return { kind: "unverified", reason: "repository_mismatch", claimed: claimedOf(candidate) };
  }
  return { kind: "needs_lookup", candidate };
}

/** GitHub's own canonical URL must agree with the identity Helm verified. */
function urlAgrees(htmlUrl: string | null, owner: string, name: string, number: number): boolean {
  if (htmlUrl === null) return true;
  const parsed = parseGitHubPullRequestUrl(htmlUrl);
  if (!parsed.ok) return false;
  return sameRepository(parsed.value, { owner, name }) && parsed.value.number === number;
}

function claimedState(value: string): "open" | "closed" | "merged" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "open" || normalized === "opened") return "open";
  if (normalized === "closed" || normalized === "close") return "closed";
  if (normalized === "merged") return "merged";
  return null;
}

function stateAgrees(claimed: string, authoritative: GitHubPullRequest): boolean {
  const normalized = claimedState(claimed);
  if (normalized === null) return true;
  if (normalized === "open") return authoritative.state === "open";
  if (normalized === "closed") return authoritative.state === "closed";
  return authoritative.merged;
}

function reviewStatusOf(pullRequest: GitHubPullRequest): OwnerReviewStatus {
  const decision = pullRequest.reviewDecision;
  if (decision === "APPROVED") return { status: "approved", source: "github" };
  if (decision === "CHANGES_REQUESTED") return { status: "changes_requested", source: "github" };
  if (decision === "REVIEW_REQUIRED") return { status: "review_required", source: "github" };
  return { status: "unknown", source: "github" };
}

/**
 * Merge readiness needs positive evidence on every count: an open, non-draft
 * pull request, an approving review decision AND GitHub's own clean
 * mergeability. Anything less stays `unknown`; Helm never guesses.
 */
function readinessOf(pullRequest: GitHubPullRequest): MergeReadiness {
  if (pullRequest.state !== "open") return "unknown";
  if (pullRequest.isDraft) return "unknown";
  if (pullRequest.reviewDecision !== "APPROVED") return "unknown";
  if (pullRequest.mergeableState !== "clean") return "unknown";
  return "ready_to_merge";
}

/**
 * Decide the pull-request state. Pure, total and deterministic.
 *
 * The order of the checks is the contract:
 *
 *  1. no claim at all -> `no_pr` (no network work, nothing to corroborate);
 *  2. the claim itself is unusable or forged -> `unverified_report`;
 *  3. the claim cannot be bound to the authorized repository -> `unverified_report`;
 *  4. the authoritative read could not be performed -> `verification_unavailable`;
 *  5. the authoritative read contradicts the claim -> `unverified_report`;
 *  6. otherwise -> the matching `verified_*` state.
 *
 * Note that step 2 and step 3 run BEFORE step 4: a forged or mis-bound claim
 * is refuted by Helm itself, without asking GitHub, and stays refuted even
 * when GitHub is unreachable.
 */
export function decidePullRequestVerification(input: PullRequestVerificationInput): PullRequestVerification {
  const screen = screenPullRequestClaim({
    candidate: input.candidate,
    identity: input.identity,
    identityConflict: input.identityConflict,
  });
  if (screen.kind === "no_pr") return { status: "no_pr" };
  if (screen.kind === "unverified") return unverified(screen.reason, screen.claimed);

  const candidate = screen.candidate;
  const claimed = claimedOf(candidate);

  if (input.response.kind === "unavailable") {
    return { status: "verification_unavailable", reason: input.response.reason };
  }
  if (input.response.kind === "not_found") {
    return unverified("pull_request_not_found", claimed);
  }

  const authoritative = input.response.pullRequest;

  if (authoritative.number !== candidate.number) return unverified("number_mismatch", claimed);

  const authoritativeBase = parseRepositoryIdentity(authoritative.baseRepository);
  if (!authoritativeBase || !sameRepository(authoritativeBase, input.identity!)) {
    return unverified("repository_mismatch", claimed);
  }

  if (!urlAgrees(authoritative.htmlUrl, input.identity!.owner, input.identity!.name, authoritative.number)) {
    return unverified("url_mismatch", claimed);
  }

  const expectedBase = input.expectedBaseBranch?.trim();
  if (expectedBase && authoritative.baseRef !== expectedBase) {
    return unverified("base_branch_mismatch", claimed);
  }
  if (candidate.baseBranch && authoritative.baseRef !== candidate.baseBranch) {
    return unverified("base_branch_mismatch", claimed);
  }
  if (candidate.headBranch && authoritative.headRef !== candidate.headBranch) {
    return unverified("head_branch_mismatch", claimed);
  }
  if (candidate.state && !stateAgrees(candidate.state, authoritative)) {
    return unverified("state_mismatch", claimed);
  }

  const identity = input.identity!;
  const pullRequest: VerifiedPullRequest = {
    number: authoritative.number,
    owner: identity.owner,
    name: identity.name,
    url: githubPullRequestUrl(identity.owner, identity.name, authoritative.number),
    baseBranch: authoritative.baseRef,
    headBranch: authoritative.headRef,
    headRepository: authoritative.headRepository,
    isDraft: authoritative.isDraft,
    mergedAt: authoritative.mergedAt,
    observedAt: input.observedAt ?? null,
  };
  const review = reviewStatusOf(authoritative);
  const readiness = readinessOf(authoritative);
  if (authoritative.merged) return { status: "verified_merged", pullRequest, review, readiness };
  if (authoritative.state === "closed") return { status: "verified_closed", pullRequest, review, readiness };
  return { status: "verified_open", pullRequest, review, readiness };
}

/* -------------------------------------------------------------------------- */
/* Read-only GitHub client                                                      */
/* -------------------------------------------------------------------------- */

export type GitHubFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Milliseconds before the authoritative read is abandoned. */
export const GITHUB_TIMEOUT_MS = 10_000;

function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  const candidate = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  return typeof candidate.timeout === "function" ? candidate.timeout(milliseconds) : undefined;
}

/**
 * Read one pull request from the GitHub REST API. **Read only.**
 *
 * The credential is passed in by the caller and is never logged, never
 * returned and never stored. Redirects are refused so the `Authorization`
 * header can never be replayed to another host.
 */
export async function requestGitHubPullRequest(input: {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly token: string;
  readonly fetchImpl?: GitHubFetchLike;
  readonly timeoutMs?: number;
}): Promise<GitHubLookup> {
  const fetchImpl = input.fetchImpl ?? ((target: string, init?: RequestInit) => fetch(target, init));
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/pulls/${input.number}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "user-agent": "helm-pull-request-verification",
        "x-github-api-version": "2022-11-28",
      },
      signal: timeoutSignal(input.timeoutMs ?? GITHUB_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable", reason: "transport_failure" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) return { kind: "unavailable", reason: "unauthorized" };
  if (response.status === 429) return { kind: "unavailable", reason: "rate_limited" };
  if (response.status === 403) {
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    return { kind: "unavailable", reason: remaining === "0" ? "rate_limited" : "unauthorized" };
  }
  if (response.status >= 500) return { kind: "unavailable", reason: "server_error" };
  if (!response.ok) return { kind: "unavailable", reason: "unexpected_response" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "unavailable", reason: "unexpected_response" };
  }
  const pullRequest = normalizeGitHubPullRequest(payload);
  if (!pullRequest) return { kind: "unavailable", reason: "unexpected_response" };
  return { kind: "found", pullRequest };
}
