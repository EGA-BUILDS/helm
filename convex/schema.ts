import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Application schema.
 *
 * EGA-676 established the foundation (no data). EGA-677 adds the two records the
 * integration gate proved are necessary before any dispatch feature is built:
 *
 *  - `credentials`: metadata about an external credential's lifetime, so dispatch
 *    can pause on auth failure. The credential VALUE is never stored here; it
 *    lives only in the environment as a secret. EGA-677 proved that every hosted
 *    auth failure collapses to a single `invalid_mcp_credential` tag, so Helm
 *    cannot distinguish "expired" from "malformed" and must treat any auth
 *    failure as a pause-and-reauthorize condition rather than a retryable error.
 *
 *  - `launchAttempts`: a durable record written BEFORE dispatch, carrying a unique
 *    correlation key. EGA-677 proved that a launch acknowledgment can be lost
 *    after T3 has already accepted the launch, and that reconciliation only works
 *    when the correlation key is unique. Ambiguous matches must never trigger an
 *    automatic relaunch.
 */
export default defineSchema({
  /**
   * Owner grant ledger (EGA-678 F1). One row per subject, upserted on
   * (re)grant for the single Helm owner; `subject` is the JWT `sub` claim
   * (never a client-supplied id) and `issuer` is the Helm Clerk instance.
   * The canonical stable identity key is the `tokenIdentifier`
   * `${issuer}|${subject}`. A row with `revokedAt === null` is active. The
   * highest active `revision` is the current authority; scheduled work
   * authorized under an older revision can be refused after rotation.
   */
  ownerGrants: defineTable({
    /** JWT `sub` claim of the owner; canonical key is `${issuer}|${subject}`. */
    subject: v.string(),
    /** Verified token issuer (the Helm Clerk instance). */
    issuer: v.string(),
    /** Grant time, ms epoch. */
    grantedAt: v.number(),
    /** Revocation time, ms epoch, or null while the grant is active. */
    revokedAt: v.union(v.number(), v.null()),
    /** Monotonic authority revision, bumped on every (re)grant. */
    revision: v.number(),
  }).index("by_subject", ["subject"]),

  /** External credential metadata. Never holds a secret value. */
  credentials: defineTable({
    /** Logical provider id, e.g. "t3-mcp" or "linear". */
    provider: v.string(),
    /**
     * `active` may dispatch. Anything else pauses dispatch for this provider.
     * `expired` is never inferred from the wire: the T3 endpoint returns
     * `invalid_mcp_credential` for expired, revoked and malformed alike, so
     * expiry is recorded as a suspicion (`paused`) until reauthorized.
     */
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("reauthorizationRequired"),
    ),
    scopes: v.array(v.string()),
    /** When the credential was issued, ms epoch. */
    issuedAt: v.number(),
    /** Declared expiry in ms epoch, or null when the issuer did not state one. */
    expiresAt: v.union(v.number(), v.null()),
    /** Last time a live call succeeded, ms epoch. */
    lastVerifiedAt: v.union(v.number(), v.null()),
    lastFailureAt: v.union(v.number(), v.null()),
    /** Normalized failure class, e.g. "invalid_mcp_credential". */
    lastFailureClass: v.union(v.string(), v.null()),
    consecutiveFailures: v.number(),
    /** Free-text note for the operator, never a secret. */
    note: v.optional(v.string()),
  })
    .index("by_provider", ["provider"])
    .index("by_status", ["status"]),

  /** Durable launch record, persisted before dispatch. */
  launchAttempts: defineTable({
    /**
     * Unique id generated before dispatch. This is the stable handle for a launch
     * whose acknowledgment may be lost, AND the durable idempotency key: a retry
     * of the same logical launch presents the same attemptId, and the stored row
     * — not process-local state — decides whether a remote launch may happen.
     */
    attemptId: v.string(),
    /**
     * SHA-256 over the canonical dispatch payload. The same attemptId with a
     * different payload is rejected rather than reused, so a retried invocation
     * can never silently mean something different from the original request.
     */
    payloadHash: v.string(),
    /** Linear issue key this attempt belongs to, e.g. "EGA-681". */
    issueKey: v.string(),
    /** Trusted isolated T3 target captured at reservation time. */
    targetProjectId: v.optional(v.string()),
    /**
     * Unique, greppable marker embedded in the launched thread's title so the
     * thread can be correlated after a lost acknowledgment. Uniqueness is what
     * makes reconciliation safe; EGA-677 only proved recovery for unique keys.
     */
    correlationKey: v.string(),
    state: v.union(
      v.literal("prepared"),
      v.literal("dispatching"),
      v.literal("acknowledged"),
      v.literal("reconciled"),
      v.literal("ambiguous"),
      v.literal("abandoned"),
    ),
    /** T3 thread id, once known. */
    threadId: v.union(v.string(), v.null()),
    dispatchedAt: v.union(v.number(), v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
    /** Number of threads found during reconciliation. */
    matchCount: v.union(v.number(), v.null()),
    /** Operator-facing note. Never a secret. */
    note: v.optional(v.string()),
  })
    .index("by_attempt_id", ["attemptId"])
    .index("by_correlation_key", ["correlationKey"])
    .index("by_issue_key", ["issueKey"])
    .index("by_issue_key_and_state", ["issueKey", "state"])
    .index("by_state", ["state"]),
});
