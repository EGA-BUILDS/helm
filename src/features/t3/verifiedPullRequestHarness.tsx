import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { VerifiedPullRequestCard } from "./VerifiedPullRequestCard";
import type { PullRequestVerification } from "../../../convex/lib/verifiedPullRequest";

/**
 * Browser-spec harness for the verified pull-request card (EGA-766).
 *
 * This file exists so the Playwright spec under `tests/frontend/` can mount
 * the REAL card component in a REAL browser without adding a second harness
 * to the test directory. It is not imported by the application.
 *
 * The card is the last place a forged URL could become a clickable link, so
 * the browser spec drives it with an unverified payload and asserts that no
 * anchor is produced at all.
 */

export function mountVerifiedPullRequestCard(
  container: HTMLElement,
  verification: PullRequestVerification | null,
): void {
  createRoot(container).render(createElement(VerifiedPullRequestCard, { verification }));
}
