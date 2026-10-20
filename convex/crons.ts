import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * B3: the PERIODIC driver for the Linear sync ledger.
 *
 * It re-drives the rows it OWNS — `pending` (an association whose sync never
 * completed: a dropped or failed trigger is recovered here) and `retryable`
 * (a Linear refusal or an unclear outcome) — with bounded backoff and
 * jitter. It never launches native work and never writes a `conflicted` or
 * `authorization_required` row.
 *
 * The tick is 5 minutes, which is the FIRST rung of the retry ladder: the
 * ladder therefore engages (a failing row is re-driven after 5, 15, 30, 60,
 * 180 and 360 minutes) instead of collapsing onto the tick, where every row
 * would be re-hit on every wake.
 */
const crons = cronJobs();
crons.interval("linear sync retryable driver", { minutes: 5 }, internal.linearSync.driveRetryable, {});
export default crons;
