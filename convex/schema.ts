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

  /** Owner-scoped native T3 OAuth connections. The token is authenticated ciphertext only. */
  t3Connections: defineTable({
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    endpoint: v.string(),
    issuer: v.string(),
    resource: v.string(),
    clientId: v.string(),
    environmentId: v.string(),
    environmentLabel: v.string(),
    serverVersion: v.string(),
    platform: v.string(),
    /**
     * What this grant may do. `read-only` is the v0.1 grant (scope
     * `orchestration:read`, six-tool read allowlist). `operate` is a SEPARATELY
     * authorised grant (scope `orchestration:read orchestration:operate`) whose
     * only additional reach is the write allowlist in `convex/t3Launch.ts`
     * (exactly `t3_thread_launch`). Existing rows keep `"read-only"`; a
     * read-only row is never upgraded — an operate grant is a new consent.
     */
    access: v.union(v.literal("read-only"), v.literal("operate")),
    status: v.union(
      v.literal("connected"),
      v.literal("expired"),
      v.literal("reauthorizationRequired"),
      v.literal("disconnected"),
      v.literal("unreachable"),
    ),
    tokenCiphertext: v.string(),
    credentialVersion: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastVerifiedAt: v.union(v.number(), v.null()),
    lastSuccessfulReadAt: v.union(v.number(), v.null()),
    /** Fixed safe categories only; never persist upstream error text. */
    lastErrorCode: v.union(
      v.literal("authorization_required"),
      v.literal("authorization_expired"),
      v.literal("endpoint_identity_changed"),
      v.literal("rate_limited"),
      v.literal("read_failed"),
      v.literal("unreachable"),
      v.literal("model_unavailable"),
      v.null(),
    ),
  })
    .index("by_owner", ["ownerSubject", "ownerIssuer"]),

  /** Short-lived, single-use OAuth state and PKCE material. */
  t3AuthAttempts: defineTable({
    attemptId: v.string(),
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    endpoint: v.string(),
    issuer: v.string(),
    resource: v.string(),
    authorizationEndpoint: v.string(),
    tokenEndpoint: v.string(),
    registrationEndpoint: v.string(),
    /** Requested grant level. Optional: legacy rows predate it and read as `"read-only"`. */
    access: v.optional(v.union(v.literal("read-only"), v.literal("operate"))),
    clientId: v.string(),
    redirectUri: v.string(),
    stateHash: v.string(),
    verifierCiphertext: v.string(),
    connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
    status: v.union(
      v.literal("pending"),
      v.literal("consuming"),
      v.literal("connected"),
      v.literal("denied"),
      v.literal("expired"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    .index("by_owner", ["ownerSubject", "ownerIssuer"])
    .index("by_state_hash", ["stateHash"])
    .index("by_attempt_id", ["attemptId"]),

  /** Owner-scoped native Linear OAuth connection. Tokens are authenticated ciphertext only. */
  linearConnections: defineTable({
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceUrlKey: v.string(),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    accessExpiresAt: v.number(),
    refreshExpiresAt: v.union(v.number(), v.null()),
    credentialVersion: v.number(),
    scopes: v.array(v.string()),
    status: v.union(
      v.literal("connected"),
      v.literal("expired"),
      v.literal("reauthorizationRequired"),
      v.literal("disconnected"),
      v.literal("unreachable"),
    ),
    lastVerifiedAt: v.union(v.number(), v.null()),
    lastSuccessfulReadAt: v.union(v.number(), v.null()),
    /** Fixed safe categories only; never persist upstream error text. */
    lastErrorCode: v.union(
      v.literal("authorization_required"),
      v.literal("authorization_expired"),
      v.literal("token_refresh_failed"),
      v.literal("workspace_identity_changed"),
      v.literal("rate_limited"),
      v.literal("read_failed"),
      v.literal("unreachable"),
      v.null(),
    ),
    clientId: v.string(),
    redirectUri: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerSubject", "ownerIssuer"]),

  /** Short-lived, single-use Linear OAuth state and PKCE material. */
  linearAuthAttempts: defineTable({
    attemptId: v.string(),
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    clientId: v.string(),
    redirectUri: v.string(),
    stateHash: v.string(),
    verifierCiphertext: v.string(),
    scopes: v.array(v.string()),
    connectionId: v.union(v.string(), v.null()),
    expectedConnectionCredentialVersion: v.union(v.number(), v.null()),
    status: v.union(
      v.literal("pending"),
      v.literal("consuming"),
      v.literal("connected"),
      v.literal("denied"),
      v.literal("expired"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    .index("by_owner", ["ownerSubject", "ownerIssuer"])
    .index("by_state_hash", ["stateHash"])
    .index("by_attempt_id", ["attemptId"]),

  /** Owner-scoped native Linear → T3 project mappings (EGA-760). */
  /**
   * Owner-scoped Linear-project -> native-T3-project mappings (v0.2 D04).
   *
   * Named `linearProjectMappings`, not `projectMappings`, so it cannot collide
   * with the superseded singleton `projectMappings` table proposed on the stale
   * PR #3 branch. That older table was sourced from deployment environment
   * variables and held exactly one mapping; this model is owner-scoped,
   * multi-row, and carries a per-team Linear workflow state.
   */
  linearProjectMappings: defineTable({
    ownerSubject: v.string(),
    ownerIssuer: v.string(),
    ownerRevision: v.number(),
    /** Verified stable Linear workspace identifier (from the OAuth identity read). */
    linearWorkspaceId: v.string(),
    linearProjectId: v.string(),
    linearProjectName: v.string(),
    /** A Linear project can carry issues from several teams: the team is part of the key. */
    linearTeamId: v.string(),
    linearTeamKey: v.string(),
    linearTeamName: v.string(),
    /** Native T3 destination. Never a project-root fallback: every field is required. */
    t3ConnectionId: v.id("t3Connections"),
    t3EnvironmentId: v.string(),
    t3ProjectId: v.string(),
    t3ProjectTitle: v.string(),
    /** Native worktree baseRef. Separate from the PR target branch; never aliased. */
    worktreeBaseRef: v.string(),
    /** PR target branch. Separate from the worktree baseRef; never aliased. */
    targetBranch: v.string(),
    /** Validated started workflow state for THIS team (never a project-wide blind pick). */
    startedStateId: v.string(),
    startedStateName: v.string(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerSubject", "ownerIssuer"])
    .index("by_owner_project_team", ["ownerSubject", "ownerIssuer", "linearProjectId", "linearTeamId"])
    .index("by_connection", ["t3ConnectionId"]),

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
    // Optional only for legacy rows created before payload binding existed.
    // Every new reservation still requires a valid hash in prepareLaunchAttempt.
    payloadHash: v.optional(v.string()),
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
