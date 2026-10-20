import styles from "./VerifiedPullRequestCard.module.css";
import {
  presentPullRequest,
  pullRequestReviewLabel,
  type PullRequestPresentation,
} from "./verifiedPullRequest";
import type { OwnerReviewStatus, PullRequestVerification } from "../../../convex/lib/verifiedPullRequest";

/**
 * The owner-facing pull-request card (EGA-766).
 *
 * Self-contained on purpose: it takes one verification result and renders
 * exactly what that result proves. It never renders a link for an unverified
 * or unavailable state, and it never renders a review line the authoritative
 * source did not give.
 *
 * The dashboard wires this in wherever a thread's pull request is shown; the
 * component itself knows nothing about threads, projects or connections.
 */

export interface VerifiedPullRequestCardProps {
  /** The verification result, or null while it is still being read. */
  readonly verification: PullRequestVerification | null;
  /** Optional heading shown above the card. */
  readonly heading?: string;
}

function reviewLabel(
  presentation: PullRequestPresentation,
  review: OwnerReviewStatus | undefined,
): string | null {
  if (presentation.kind !== "verified") return null;
  return pullRequestReviewLabel(review);
}

export function VerifiedPullRequestCard({ verification, heading = "PULL REQUEST" }: VerifiedPullRequestCardProps) {
  const presentation = presentPullRequest(verification);
  const review = verification && (verification.status === "verified_open" || verification.status === "verified_closed" ||
    verification.status === "verified_merged")
    ? verification.review
    : undefined;
  const label = reviewLabel(presentation, review);

  return (
    <section className={styles.card} data-kind={presentation.kind} data-state={presentation.state ?? "none"} aria-label="Pull request">
      <p className={styles.eyebrow}>{heading}</p>
      <h3 className={styles.title}>{presentation.title}</h3>
      {presentation.kind === "unverified" ? (
        <p className={styles.unverified} data-role="unverified-detail">{presentation.detail}</p>
      ) : (
        <p className={styles.detail} data-role="detail">{presentation.detail}</p>
      )}
      {presentation.href ? (
        <a className={styles.link} data-role="pull-request-link" href={presentation.href} target="_blank" rel="noreferrer noopener">
          Open pull request #{presentation.number} on GitHub
        </a>
      ) : null}
      {label ? <p className={styles.review} data-role="review" data-review={presentation.review}>{label}</p> : null}
      {presentation.caveat ? <p className={styles.caveat} data-role="caveat">{presentation.caveat}</p> : null}
    </section>
  );
}

export default VerifiedPullRequestCard;
