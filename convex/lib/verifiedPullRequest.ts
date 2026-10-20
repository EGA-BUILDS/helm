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
 * Git host says so, AND when it is bound to the thread it is claimed for.
 * Existence in a repository is not enough: a pull request that merely shares
 * a number with a claim is somebody else's pull request.
 *
 * ## The binding (EGA-766 review B1)
 *
 * Every verified state requires ALL of:
 *
 *  1. a **repository identity** resolved from an authorized source;
 *  2. a **thread binding**: the authorized T3 thread read must report a
 *     branch, and the authoritative pull request's `head.ref` must be exactly
 *     that branch. A thread with no branch cannot be bound, so nothing is
 *     verified for it (`thread_not_bound`);
 *  3. a **complete claim**: the claim must carry the pull-request number, the
 *     repository, the target branch, the head branch and the state. A missing
 *     field is not evidence, so the claim is refused rather than the
 *     corresponding check being skipped.
 *
 * With (2) in place a compromised T3 cannot get an arbitrary repository
 * marked verified: it would have to name a repository that really contains a
 * pull request whose head branch is exactly the branch it claims.
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
 *    without asking GitHub;
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
/** Read-only GitHub REST base. */
export const GITHUB_API_BASE = "https://api.github.com";
/** Longest accepted claim text. Keeps parsing bounded on untrusted input. */
export const MAX_CLAIM_LENGTH = 2048;
/** Longest accepted repository identity. */
export const MAX_IDENTITY_LENGTH = 512;
/** Reviews read per verification attempt. A full page means "not conclusive". */
export const GITHUB_REVIEWS_PER_PAGE = 100;

/* -------------------------------------------------------------------------- */
/* Repository identity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A repository identity Helm resolved from an authorized source.
 *
 * `source` records WHICH authorized source produced it, because the two
 * sources are not interchangeable and the difference is visible to the owner:
 *
 *  - `operator_configuration` is deployment configuration set by the owner.
 *    It is the authoritative identity.
 *  - `t3_project` is T3's own claim about the project. It is weaker: T3 is
 *    the system whose output Helm distrusts, so an identity that comes only
 *    from T3 is disclosed as such in the owner-facing result and can never
 *    override the operator configuration.
 *
 * When the two exist and disagree, Helm refuses to bind a claim to either.
 */
export interface RepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly source: "operator_configuration" | "t3_project";
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
  // No whitespace and no control characters anywhere in an identity.
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
 * Reconcile the two authorized identities.
 *
 * The operator configuration is AUTHORITATIVE: when it is present, T3's own
 * project record must agree with it or nothing is verified at all. When it is
 * absent, T3's record is used, and the weaker provenance travels with the
 * result so the owner is told the identity was asserted by T3.
 */
export function resolveRepositoryIdentity(input: {
  readonly t3ProjectIdentity: unknown;
  readonly operatorConfigured: unknown;
}): { readonly identity: RepositoryIdentity | null; readonly conflict: boolean } {
  const t3 = parseRepositoryIdentity(input.t3ProjectIdentity, "t3_project");
  const configured = parseRepositoryIdentity(input.operatorConfigured, "operator_configuration");
  if (configured && t3 && !sameRepository(configured, t3)) return { identity: null, conflict: true };
  return { identity: configured ?? t3, conflict: false };
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
 * This is the anti-forgery gate, and it is deliberately exact:
 *
 *  - HTTPS only, no embedded credentials;
 *  - the host must be exactly `github.com` — `www.github.com` and every other
 *    host are refused;
 *  - the path must be exactly `/{owner}/{name}/pull/{number}` (one trailing
 *    slash is allowed). No extra path segments, no other pull-request routes.
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
  if (url.hostname.toLowerCase() !== GITHUB_HOST) return { ok: false, reason: "non_github_url" };
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match) return { ok: false, reason: "malformed_pr_url" };
  const owner = match[1]!;
  const name = match[2]!;
  if (!validOwnerName(owner) || !validOwnerName(name)) return { ok: false, reason: "malformed_pr_url" };
  const rawNumber = match[3]!;
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
 * Only KNOWN URL fields are claims.
 *
 * A known URL field is read as the claim's URL, so a forged link there is
 * refused with a specific reason. Any OTHER top-level string is NOT a claim:
 * it is only inspected to make sure it does not smuggle a pull-request URL.
 * A pull-request URL in an unrelated field (a documentation link, a note) is
 * refused, because Helm will not guess which field was meant. Every other
 * value — an issue link, a commit link, a repository link, plain prose — is
 * ignored: it is neither promoted into a claim nor allowed to fail one.
 */
function claimedUrlStrings(source: Record<string, unknown>): { urls: string[]; foreignPullRequestUrl: boolean } {
  const urls: string[] = [];
  for (const key of URL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) urls.push(value.trim());
  }
  let foreignPullRequestUrl = false;
  for (const [key, value] of Object.entries(source)) {
    if ((URL_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const trimmed = value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) continue;
    // A pull-request URL in a field that is not a URL field is never promoted
    // into the claim; it is refused so it cannot hide there.
    if (parseGitHubPullRequestUrl(trimmed).ok) {
      foreignPullRequestUrl = true;
      continue;
    }
    // Every other link (issues, commits, other repositories, documentation)
    // is ignored entirely: not a claim, and not a reason to fail one.
  }
  return { urls, foreignPullRequestUrl };
}

/**
 * Read an untrusted `linkedPullRequest` record as a pull-request reference.
 *
 * The shape of T3's record is not published, so the parser accepts a bounded
 * set of field aliases and refuses anything it cannot read. It never promotes
 * an unrelated field into a claim.
 */
export function parsePullRequestCandidate(raw: unknown):
  | { readonly ok: true; readonly candidate: PullRequestCandidate }
  | { readonly ok: false; readonly reason: CandidateRejection } {
  if (!isRecord(raw)) return { ok: false, reason: "candidate_not_recognised" };

  const { urls: urlStrings, foreignPullRequestUrl } = claimedUrlStrings(raw);
  if (foreignPullRequestUrl) return { ok: false, reason: "candidate_inconsistent" };

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

/**
 * The review decision Helm derived from the authoritative reviews.
 *
 * The pull-request endpoint does NOT report a review decision, so Helm reads
 * the reviews themselves and derives one conservatively. `null` means "no
 * evidence", never "not approved".
 */
export type GitHubReviewDecision = "APPROVED" | "CHANGES_REQUESTED";

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
  readonly mergeableState: string | null;
}

function repositoryFullName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const fullName = value.full_name ?? value.fullName;
  if (typeof fullName !== "string") return null;
  const identity = parseRepositoryIdentity(fullName);
  return identity ? `${identity.owner}/${identity.name}` : null;
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
    mergeableState: typeof raw.mergeable_state === "string" ? raw.mergeable_state : null,
  };
}

/** One review as GitHub reports it. */
export interface GitHubReview {
  readonly id: number;
  readonly user: string | null;
  readonly state: string;
  readonly submittedAt: string | null;
}

/** Normalize the reviews payload. `null` when it cannot be read. */
export function normalizeGitHubReviews(raw: unknown): GitHubReview[] | null {
  if (!Array.isArray(raw)) return null;
  const reviews: GitHubReview[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const id = entry.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
    const state = entry.state;
    if (typeof state !== "string") return null;
    const user = isRecord(entry.user) && typeof entry.user.login === "string" ? entry.user.login : null;
    reviews.push({
      id,
      user,
      state: state.toUpperCase(),
      submittedAt: typeof entry.submitted_at === "string" ? entry.submitted_at : null,
    });
  }
  return reviews;
}

/**
 * Derive a review decision from the authoritative reviews.
 *
 * Deliberately conservative, because the pull-request endpoint does not report
 * a review decision and Helm will not invent one:
 *
 *  - dismissed and pending reviews are ignored;
 *  - the LATEST review per reviewer wins, which is GitHub's own rule;
 *  - a single outstanding "changes requested" outranks any approval;
 *  - "approved" requires at least one approving review and no outstanding
 *    change request;
 *  - a truncated list is NOT conclusive, so it yields no decision at all.
 *
 * `REVIEW_REQUIRED` is never reported: GitHub derives it from the
 * repository's branch-protection rules, and Helm does not read those.
 */
export function deriveReviewDecision(reviews: readonly GitHubReview[]): GitHubReviewDecision | null {
  if (reviews.length >= GITHUB_REVIEWS_PER_PAGE) return null;
  const latest = new Map<string, GitHubReview>();
  for (const review of reviews) {
    if (review.state === "DISMISSED" || review.state === "PENDING") continue;
    const key = review.user ?? `#${review.id}`;
    const current = latest.get(key);
    if (!current) {
      latest.set(key, review);
      continue;
    }
    const currentTime = current.submittedAt ? Date.parse(current.submittedAt) : 0;
    const nextTime = review.submittedAt ? Date.parse(review.submittedAt) : 0;
    if (nextTime > currentTime || (nextTime === currentTime && review.id > current.id)) {
      latest.set(key, review);
    }
  }
  const decisions = [...latest.values()].map((review) => review.state);
  if (decisions.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (decisions.includes("APPROVED")) return "APPROVED";
  return null;
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
  | { readonly kind: "found"; readonly pullRequest: GitHubPullRequest; readonly reviewDecision: GitHubReviewDecision | null }
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
  | "thread_not_bound"
  | "claim_missing_base_branch"
  | "claim_missing_head_branch"
  | "claim_missing_state"
  | "number_mismatch"
  | "url_mismatch"
  | "url_not_confirmed"
  | "base_branch_mismatch"
  | "head_branch_mismatch"
  | "state_mismatch"
  | "pull_request_not_found";

/** Owner-review status. Only ever derived from the authoritative response. */
export type OwnerReviewStatus =
  | { readonly status: "approved"; readonly source: "github" }
  | { readonly status: "changes_requested"; readonly source: "github" }
  | { readonly status: "unknown"; readonly source: "github" };

/** Merge readiness. Only ever derived from the authoritative response. */
export type MergeReadiness = "ready_to_merge" | "unknown";

/**
 * The binding between a thread and the pull request it claims.
 *
 * `branch` comes from the authorized T3 thread read. It is the only stable
 * evidence that ties a pull request to THIS thread's work: the authoritative
 * pull request's head branch must be exactly this branch.
 */
export interface ThreadBinding {
  readonly threadId: string;
  readonly branch: string | null;
}

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
  /** Which authorized source supplied the repository identity. */
  readonly identitySource: RepositoryIdentity["source"];
  /** The thread this pull request is bound to. */
  readonly threadId: string;
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
  /** The thread this pull request is claimed for. Mandatory for a verified state. */
  readonly thread: ThreadBinding | null;
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
 * network read is needed at all. A forged claim, an incomplete claim, an
 * unbindable claim and a conflicting repository identity are all settled here,
 * before any request is made — and they stay settled even when GitHub is
 * unreachable.
 */
export type ClaimScreen =
  | { readonly kind: "no_pr" }
  | { readonly kind: "unverified"; readonly reason: UnverifiedReason; readonly claimed: ClaimedPullRequest | null }
  | { readonly kind: "needs_lookup"; readonly candidate: PullRequestCandidate };

export function screenPullRequestClaim(input: {
  readonly candidate: unknown;
  readonly identity: RepositoryIdentity | null;
  readonly identityConflict?: boolean;
  readonly thread: ThreadBinding | null;
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

  // The thread binding. Without a branch reported by the authorized thread
  // read there is nothing that ties a pull request to this thread, so
  // existence in the repository is never enough.
  const threadBranch = input.thread?.branch?.trim() ?? "";
  if (threadBranch.length === 0) {
    return { kind: "unverified", reason: "thread_not_bound", claimed: claimedOf(candidate) };
  }

  // A claim that omits a field it is supposed to assert is not evidence. The
  // corresponding check is NOT skipped: the claim is refused.
  if (!candidate.baseBranch) {
    return { kind: "unverified", reason: "claim_missing_base_branch", claimed: claimedOf(candidate) };
  }
  if (!candidate.headBranch) {
    return { kind: "unverified", reason: "claim_missing_head_branch", claimed: claimedOf(candidate) };
  }
  if (!candidate.state) {
    return { kind: "unverified", reason: "claim_missing_state", claimed: claimedOf(candidate) };
  }

  return { kind: "needs_lookup", candidate };
}

/**
 * GitHub's own canonical URL must agree with the identity Helm verified.
 *
 * A missing authoritative URL is NOT agreement: without it the URL could not
 * be confirmed, so the verification fails closed.
 */
function urlAgrees(htmlUrl: string | null, owner: string, name: string, number: number):
  { readonly ok: true } | { readonly ok: false; readonly reason: "url_mismatch" | "url_not_confirmed" } {
  if (htmlUrl === null) return { ok: false, reason: "url_not_confirmed" };
  const parsed = parseGitHubPullRequestUrl(htmlUrl);
  if (!parsed.ok) return { ok: false, reason: "url_mismatch" };
  if (!sameRepository(parsed.value, { owner, name })) return { ok: false, reason: "url_mismatch" };
  if (parsed.value.number !== number) return { ok: false, reason: "url_mismatch" };
  return { ok: true };
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

function reviewStatusOf(decision: GitHubReviewDecision | null): OwnerReviewStatus {
  if (decision === "APPROVED") return { status: "approved", source: "github" };
  if (decision === "CHANGES_REQUESTED") return { status: "changes_requested", source: "github" };
  return { status: "unknown", source: "github" };
}

/**
 * Merge readiness needs positive evidence on every count: an open, non-draft
 * pull request, an approving review decision AND GitHub's own clean
 * mergeability. Anything less stays `unknown`; Helm never guesses.
 */
function readinessOf(pullRequest: GitHubPullRequest, decision: GitHubReviewDecision | null): MergeReadiness {
  if (pullRequest.state !== "open") return "unknown";
  if (pullRequest.isDraft) return "unknown";
  if (decision !== "APPROVED") return "unknown";
  if (pullRequest.mergeableState !== "clean") return "unknown";
  return "ready_to_merge";
}

/**
 * Decide the pull-request state. Pure, total and deterministic.
 *
 * The order of the checks is the contract:
 *
 *  1. no claim at all -> `no_pr` (no network work, nothing to corroborate);
 *  2. the claim itself is unusable, forged, incomplete or unbound ->
 *     `unverified_report`;
 *  3. the authoritative read could not be performed -> `verification_unavailable`;
 *  4. the authoritative read contradicts the claim -> `unverified_report`;
 *  5. otherwise -> the matching `verified_*` state.
 *
 * Note that step 2 runs BEFORE step 3: a forged, incomplete or unbound claim
 * is refuted by Helm itself, without asking GitHub, and stays refuted even
 * when GitHub is unreachable.
 */
export function decidePullRequestVerification(input: PullRequestVerificationInput): PullRequestVerification {
  const screen = screenPullRequestClaim({
    candidate: input.candidate,
    identity: input.identity,
    identityConflict: input.identityConflict,
    thread: input.thread,
  });
  if (screen.kind === "no_pr") return { status: "no_pr" };
  if (screen.kind === "unverified") return unverified(screen.reason, screen.claimed);

  const candidate = screen.candidate;
  const claimed = claimedOf(candidate);
  const identity = input.identity!;
  const thread = input.thread!;
  const threadBranch = thread.branch!.trim();

  if (input.response.kind === "unavailable") {
    return { status: "verification_unavailable", reason: input.response.reason };
  }
  if (input.response.kind === "not_found") {
    return unverified("pull_request_not_found", claimed);
  }

  const authoritative = input.response.pullRequest;

  if (authoritative.number !== candidate.number) return unverified("number_mismatch", claimed);

  const authoritativeBase = parseRepositoryIdentity(authoritative.baseRepository);
  if (!authoritativeBase || !sameRepository(authoritativeBase, identity)) {
    return unverified("repository_mismatch", claimed);
  }

  // The binding: the authoritative head branch must be the thread's branch.
  // This is what makes a verified pull request THIS thread's pull request.
  if (authoritative.headRef !== threadBranch) return unverified("head_branch_mismatch", claimed);
  if (authoritative.headRef !== candidate.headBranch) return unverified("head_branch_mismatch", claimed);

  if (authoritative.baseRef !== candidate.baseBranch) return unverified("base_branch_mismatch", claimed);
  const expectedBase = input.expectedBaseBranch?.trim();
  if (expectedBase && authoritative.baseRef !== expectedBase) {
    return unverified("base_branch_mismatch", claimed);
  }

  const url = urlAgrees(authoritative.htmlUrl, identity.owner, identity.name, authoritative.number);
  if (!url.ok) return unverified(url.reason, claimed);

  if (candidate.state && !stateAgrees(candidate.state, authoritative)) {
    return unverified("state_mismatch", claimed);
  }

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
    identitySource: identity.source,
    threadId: thread.threadId,
    observedAt: input.observedAt ?? null,
  };
  const review = reviewStatusOf(input.response.reviewDecision);
  const readiness = readinessOf(authoritative, input.response.reviewDecision);
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

interface GitHubResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

async function githubGet(
  fetchImpl: GitHubFetchLike,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<{ readonly kind: "response"; readonly response: GitHubResponse } | { readonly kind: "unavailable"; readonly reason: UnavailableReason }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "helm-pull-request-verification",
        "x-github-api-version": "2022-11-28",
      },
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { kind: "unavailable", reason: "transport_failure" };
  }
  return { kind: "response", response: response as unknown as GitHubResponse };
}

function unavailableForStatus(response: GitHubResponse): UnavailableReason | null {
  const status = response.status;
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    return remaining === "0" ? "rate_limited" : "unauthorized";
  }
  if (status >= 500) return "server_error";
  if (status < 200 || status >= 300) return "unexpected_response";
  return null;
}

/**
 * Read one pull request and its reviews from the GitHub REST API.
 *
 * **Read only.** Two `GET`s at most, both against `api.github.com`:
 *
 *  - `/repos/{owner}/{repo}/pulls/{number}` — the authoritative state;
 *  - `/repos/{owner}/{repo}/pulls/{number}/reviews` — the authoritative
 *    reviews. The pull-request endpoint does NOT report a review decision, so
 *    Helm reads the reviews and derives one conservatively. A failed reviews
 *    read leaves the review status UNKNOWN; it never fails the pull request
 *    verification itself.
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
  const timeoutMs = input.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/pulls/${input.number}`;

  const pull = await githubGet(fetchImpl, base, input.token, timeoutMs);
  if (pull.kind === "unavailable") return pull;
  if (pull.response.status === 404) return { kind: "not_found" };
  const failure = unavailableForStatus(pull.response);
  if (failure) return { kind: "unavailable", reason: failure };

  let payload: unknown;
  try {
    payload = await pull.response.json();
  } catch {
    return { kind: "unavailable", reason: "unexpected_response" };
  }
  const pullRequest = normalizeGitHubPullRequest(payload);
  if (!pullRequest) return { kind: "unavailable", reason: "unexpected_response" };

  // Best effort, and fail-closed on the REVIEW STATUS only.
  const reviews = await githubGet(fetchImpl, `${base}/reviews?per_page=${GITHUB_REVIEWS_PER_PAGE}`, input.token, timeoutMs);
  let reviewDecision: GitHubReviewDecision | null = null;
  if (reviews.kind === "response" && reviews.response.status >= 200 && reviews.response.status < 300) {
    try {
      const list = normalizeGitHubReviews(await reviews.response.json());
      if (list) reviewDecision = deriveReviewDecision(list);
    } catch {
      reviewDecision = null;
    }
  }

  return { kind: "found", pullRequest, reviewDecision };
}
