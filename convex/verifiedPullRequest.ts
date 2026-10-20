"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  decidePullRequestVerification,
  requestGitHubPullRequest,
  resolveRepositoryIdentity,
  screenPullRequestClaim,
  type RepositoryIdentity,
} from "./lib/verifiedPullRequest";

/**
 * Verified pull-request state for native T3 execution (EGA-766).
 *
 * This action is the only place that touches the Git host, and it does so
 * **read-only**: one `GET /repos/{owner}/{repo}/pulls/{number}` per attempt.
 * There is no push, no branch creation, no pull-request creation and no merge
 * anywhere in Helm. `convex/verifiedPullRequest.test.ts` asserts that from
 * source.
 *
 * ## Where the three inputs come from
 *
 *  - the **candidate** is `thread.linkedPullRequest` from the owner-authorized
 *    T3 thread read. It is a claim and is treated as one;
 *  - the **repository identity** is resolved from the owner-authorized T3
 *    project read for the thread's own project, with the operator-configured
 *    `HELM_GITHUB_REPOSITORY` only as a fallback. It is never taken from the
 *    claim;
 *  - the **authoritative response** is the GitHub REST read, or the reason it
 *    could not be performed.
 *
 * The project is read through the thread's own `projectId`, so a caller can
 * never point the verification at another project.
 *
 * ## Credential
 *
 * `GITHUB_TOKEN` must hold a read-only GitHub credential (fine-grained token
 * with `Pull requests: read` on the target repositories, or a classic PAT with
 * `public_repo`/`repo`). When it is absent the result is
 * `verification_unavailable` — never a false positive.
 *
 * The token is read here, used only as an `Authorization` header, and never
 * logged, returned or stored.
 */

type Owner = { subject: string; issuer: string; revision: number };

/**
 * Narrow structural view over the `t3OAuth.read` union.
 *
 * The annotation keeps this module's inferred type from feeding back into the
 * `api` namespace (see `convex/_generated/ai/guidelines.md`), and every union
 * variant overlaps the view: `environmentId` covers the environment variant,
 * `providers` the catalog, `repositoryIdentity` the project, `items` a page
 * and `thread` the thread detail. The runtime guards below fail closed on any
 * shape change.
 */
type T3ReadProjection = {
  environmentId?: unknown;
  providers?: unknown;
  repositoryIdentity?: unknown;
  items?: unknown;
  thread?: unknown;
};

const claimedPullRequest = v.object({
  number: v.union(v.number(), v.null()),
  owner: v.union(v.string(), v.null()),
  name: v.union(v.string(), v.null()),
});

const verifiedPullRequest = v.object({
  number: v.number(),
  owner: v.string(),
  name: v.string(),
  url: v.string(),
  baseBranch: v.string(),
  headBranch: v.string(),
  headRepository: v.union(v.string(), v.null()),
  isDraft: v.boolean(),
  mergedAt: v.union(v.string(), v.null()),
  observedAt: v.union(v.string(), v.null()),
});

const ownerReviewStatus = v.object({
  status: v.union(
    v.literal("approved"),
    v.literal("changes_requested"),
    v.literal("review_required"),
    v.literal("unknown"),
  ),
  source: v.literal("github"),
});

const verifiedBlock = {
  pullRequest: verifiedPullRequest,
  review: ownerReviewStatus,
  readiness: v.union(v.literal("ready_to_merge"), v.literal("unknown")),
};

const verificationReturns = v.union(
  v.object({ status: v.literal("no_pr") }),
  v.object({
    status: v.literal("unverified_report"),
    reason: v.union(
      v.literal("candidate_not_recognised"),
      v.literal("candidate_inconsistent"),
      v.literal("non_github_url"),
      v.literal("malformed_pr_url"),
      v.literal("malformed_pr_number"),
      v.literal("repository_not_identified"),
      v.literal("repository_mismatch"),
      v.literal("number_mismatch"),
      v.literal("url_mismatch"),
      v.literal("base_branch_mismatch"),
      v.literal("head_branch_mismatch"),
      v.literal("state_mismatch"),
      v.literal("pull_request_not_found"),
    ),
    claimed: v.union(claimedPullRequest, v.null()),
  }),
  v.object({ status: v.literal("verified_open"), ...verifiedBlock }),
  v.object({ status: v.literal("verified_closed"), ...verifiedBlock }),
  v.object({ status: v.literal("verified_merged"), ...verifiedBlock }),
  v.object({
    status: v.literal("verification_unavailable"),
    reason: v.union(
      v.literal("no_credential"),
      v.literal("unauthorized"),
      v.literal("rate_limited"),
      v.literal("transport_failure"),
      v.literal("server_error"),
      v.literal("unexpected_response"),
    ),
  }),
);

export type PullRequestVerificationResult = Infer<typeof verificationReturns>;

/**
 * The authorized repository identity for one T3 project.
 *
 * The T3 project read is owner-scoped, so it is the primary source. The
 * operator configuration only covers deployments whose T3
 * `repositoryIdentity.canonicalKey` is not an `owner/name` pair; when both
 * exist and disagree, the identity is refused rather than guessed.
 */
async function resolveIdentity(
  ctx: ActionCtx,
  connectionId: Id<"t3Connections">,
  projectId: string,
): Promise<{ identity: RepositoryIdentity | null; conflict: boolean }> {
  const project: T3ReadProjection = await ctx.runAction(api.t3OAuth.read, {
    connectionId,
    operation: "project",
    input: { projectId },
  });
  return resolveRepositoryIdentity({
    t3ProjectIdentity: project.repositoryIdentity,
    operatorConfigured: process.env.HELM_GITHUB_REPOSITORY,
  });
}

export const verify = action({
  args: { connectionId: v.id("t3Connections"), threadId: v.string() },
  returns: verificationReturns,
  handler: async (
    ctx: ActionCtx,
    args: { connectionId: Id<"t3Connections">; threadId: string },
  ): Promise<PullRequestVerificationResult> => {
    // Owner authorization happens BEFORE any read or network call.
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    await ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject,
      issuer: owner.issuer,
      revision: owner.revision,
    });

    if (args.threadId.trim().length === 0 || args.threadId.length > 256) {
      throw new Error("T3 thread id is invalid");
    }

    const detail: T3ReadProjection = await ctx.runAction(api.t3OAuth.read, {
      connectionId: args.connectionId,
      operation: "thread",
      input: { threadId: args.threadId },
    });
    const thread = (detail.thread ?? {}) as { projectId?: unknown; linkedPullRequest?: unknown };
    const candidate = thread.linkedPullRequest ?? null;

    // T3 reports no linked pull request at all: there is nothing to
    // corroborate, so neither the project read nor GitHub is asked for.
    if (candidate === null || candidate === undefined ||
        (typeof candidate === "object" && !Array.isArray(candidate) && Object.keys(candidate).length === 0)) {
      return { status: "no_pr" };
    }

    const projectId = typeof thread.projectId === "string" ? thread.projectId : "";
    const resolved = projectId
      ? await resolveIdentity(ctx, args.connectionId, projectId)
      : { identity: null, conflict: false };

    // Everything Helm can settle on its own is settled BEFORE GitHub is asked:
    // a forged claim, or a claim that cannot be bound to the authorized
    // repository, never becomes a network request.
    const screen = screenPullRequestClaim({
      candidate,
      identity: resolved.identity,
      identityConflict: resolved.conflict,
    });
    const observedAt = new Date().toISOString();
    if (screen.kind === "no_pr") return { status: "no_pr" };
    if (screen.kind === "unverified") {
      return { status: "unverified_report", reason: screen.reason, claimed: screen.claimed };
    }

    // Without a credential Helm cannot corroborate anything. That is
    // `verification_unavailable`, never a verified state and never a guess.
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      return { status: "verification_unavailable", reason: "no_credential" };
    }

    const lookup = await requestGitHubPullRequest({
      owner: screen.candidate.owner!,
      name: screen.candidate.name!,
      number: screen.candidate.number!,
      token,
    });

    return decidePullRequestVerification({
      candidate,
      identity: resolved.identity,
      identityConflict: resolved.conflict,
      response: lookup,
      observedAt,
    }) as PullRequestVerificationResult;
  },
});

export default verify;
