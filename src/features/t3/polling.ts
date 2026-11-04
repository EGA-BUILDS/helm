/**
 * Bounded browser polling policy for EGA-815.
 *
 * This module is deliberately pure and clock-free so the cadence, backoff and
 * eligibility rules can be tested without a browser. The React controller owns
 * the timers and the network calls; this file only decides *whether* a selected
 * thread may be polled and *how long* to wait after a result.
 *
 * Nothing here creates a daemon, scheduler, queue or transcript store. The only
 * thing being refreshed is the one thread the owner has open in this tab.
 */

import { classifyThreadStatus } from "./ui";

/** One selected, visible, running thread: start conservative. */
export const ACTIVITY_POLL_INTERVAL_MS = 15_000;
/** A failing thread backs off to at most two minutes between attempts. */
export const ACTIVITY_POLL_MAX_INTERVAL_MS = 120_000;

/** The cross-project summary is a separate, slower loop. */
export const SUMMARY_POLL_INTERVAL_MS = 60_000;
export const SUMMARY_POLL_MAX_INTERVAL_MS = 300_000;

/** Never honour an upstream Retry-After beyond this, even if it asks. */
export const POLL_RETRY_AFTER_MAX_MS = 300_000;

/**
 * Clamp an upstream Retry-After hint. Only a finite, positive value is used;
 * a malformed or absent header falls back to exponential backoff.
 */
export function boundedRetryAfterMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.max(Math.round(value), 1_000), POLL_RETRY_AFTER_MAX_MS);
}

/**
 * Delay before the next selected-thread activity read.
 *
 * `failures` is the number of consecutive failed attempts. The first failure
 * waits two base intervals, then doubles, capped at `ACTIVITY_POLL_MAX_INTERVAL_MS`.
 * A valid Retry-After can only extend the exponential delay; it never shortens
 * it. Both values are bounded.
 */
export function activityPollDelay(failures: number, retryAfterMs?: number | null): number {
  const exponential = failures <= 0
    ? ACTIVITY_POLL_INTERVAL_MS
    : Math.min(
      ACTIVITY_POLL_MAX_INTERVAL_MS,
      ACTIVITY_POLL_INTERVAL_MS * 2 ** Math.min(failures, 4),
    );
  const retry = boundedRetryAfterMs(retryAfterMs);
  // A server hint may only extend the failure backoff. Honouring a short
  // Retry-After as a *replacement* would amplify a 429 storm.
  return retry === null ? exponential : Math.max(exponential, retry);
}

/** Delay before the next cross-project summary read. */
export function summaryPollDelay(failures: number, retryAfterMs?: number | null): number {
  const exponential = failures <= 0
    ? SUMMARY_POLL_INTERVAL_MS
    : Math.min(
      SUMMARY_POLL_MAX_INTERVAL_MS,
      SUMMARY_POLL_INTERVAL_MS * 2 ** Math.min(failures, 3),
    );
  const retry = boundedRetryAfterMs(retryAfterMs);
  return retry === null ? exponential : Math.max(exponential, retry);
}

/**
 * Why a selected thread must not be polled right now.
 *
 * `null` means polling is allowed. Every other value is an honest, UI-visible
 * pause reason. `inactive` and `unknown` are deliberately distinct: a quiet
 * thread is not evidence of work, and an unrecognised native status is not
 * evidence of a run.
 */
export type ActivityPollPauseReason =
  | "disabled"
  | "hidden"
  | "disconnected"
  | "inactive"
  | "unknown"
  | "not-loaded"
  | "more-activity"
  | "no-cursor"
  | "stopped";

export interface ActivityPollInput {
  readonly enabled: boolean;
  readonly documentVisible: boolean;
  readonly connected: boolean;
  readonly threadStatus: string | null | undefined;
  readonly detailReady: boolean;
  readonly hasMore: boolean;
  readonly nextPosition: number | null | undefined;
}

export function activityPollPauseReason(input: ActivityPollInput): ActivityPollPauseReason | null {
  if (!input.enabled) return "disabled";
  if (!input.documentVisible) return "hidden";
  if (!input.connected) return "disconnected";
  if (input.threadStatus === null || input.threadStatus === undefined || input.threadStatus.trim() === "") return "unknown";
  const kind = classifyThreadStatus(input.threadStatus);
  // The EGA-811 contract keeps `idle`, `active`, `archived`, `pending_*` and
  // unrecognised values at Unknown. They are not evidence of a live run.
  if (kind === "unknown") return "unknown";
  if (kind !== "running") return "inactive";
  if (!input.detailReady) return "not-loaded";
  // Do not auto-consume older activity pages: that is what Load more is for,
  // and it keeps the incremental cursor unambiguous.
  if (input.hasMore) return "more-activity";
  if (input.nextPosition === null || input.nextPosition === undefined) return "no-cursor";
  return null;
}
