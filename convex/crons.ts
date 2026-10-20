import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * B3: periodic driver for `retryable` Linear sync ledger rows. Re-drives only
 * the safe-to-retry state, with bounded backoff; never launches native work.
 */
const crons = cronJobs();
crons.interval("linear sync retryable driver", { minutes: 1 }, internal.linearSync.driveRetryable, {});
export default crons;
