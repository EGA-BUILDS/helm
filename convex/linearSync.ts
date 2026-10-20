"use node";

import { v, type Infer } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

import { decryptLinearSecret, linearAccessPurpose } from "./lib/linearHelpers";
import { fetchLinearIssueDetail, type LinearIssueDetail } from "./lib/linearIssues";
import {
  fetchLinearTeamStates,
  LinearMisconfiguration,
  requestLinearGraphql,
  requireStartedState,
} from "./lib/linearGraphql";
import { syncErrorCode } from "./linearSyncStore";

/**
 * Linear In Progress synchronization (EGA-762).
 *
 * This module is the ONLY Linear write path Helm has, and it may set In
 * Progress ONLY — never Done, never Canceled — and only after an issue has an
 * accepted association (`linearIssueThreads`).
 *
 * State discipline, on top of the independent `linearSyncLedger`:
 *
 *   1. Every sync attempt is ledgered BEFORE any network call
 *      (`attemptCount` increments, rows rest at `pending`), so a crash never
 *      loses the fact that an attempt was made. A sync only ever touches
 *      associations bound to the SAME resolved (project, team) identity it
 *      was called with — a row for another team can never be marked synced
 *      with another team's target state.
 *   2. The target state is resolved from the issue's OWN team by a live
 *      workflow-states read, validated with `requireStartedState` — never a
 *      hardcoded name and never another team's state. A stale mapped state
 *      is a CONFIGURATION stop (`misconfigured` / `conflicted`), not a
 *      retryable network failure.
 *   3. Guards NEVER overwrite: an issue that is Done, Canceled, moved to
 *      another team, moved by a human (any direction) away from the state
 *      Helm last observed, or externally state-changed between Helm's two
 *      reads is recorded `conflicted` and left untouched. The human-intent
 *      verdict is STICKY: that conflict never advances the ledger's observed
 *      baseline, so every later sync keeps refusing until the issue returns
 *      to the recorded state. An ambiguous observed history fails closed.
 *   4. NOTHING is trusted until proven otherwise: HTTP 200 with a GraphQL
 *      `errors` array is FAILURE on the write AND on every read, a timeout is
 *      uncertainty, and a `success: false` field is a definite REFUSAL
 *      (`write_rejected`). In all cases a re-read happens before the ledger
 *      concludes anything, and only observed truth can produce `synced`.
 *   5. Linear `429` is a definite rejection: recorded `retryable`
 *      (`rate_limited`) without touching the issue.
 *   6. Sync and execution are independent: this module issues NO T3 calls and
 *      can never relaunch a thread. Every failure stays on the ledger.
 *   7. Retry has TWO drivers, and they share ONE contention point: the
 *      launch path schedules an immediate sync when it records a NEW
 *      association (`ctx.scheduler.runAfter`), and the periodic driver
 *      (`convex/crons.ts` -> `driveRetryable`) re-drives the rows it OWNS —
 *      `pending` and `retryable` — with bounded backoff. Both of them claim
 *      the issue's ledger row (`syncing`) before they write anything, so the
 *      two drivers can never write the same Linear issue twice in one
 *      window. Neither driver ever launches native work. Operators call
 *      `syncIssue` explicitly for `conflicted` / `authorization_required`
 *      rows, or to force a retry.
 */

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const MAX_ID_LENGTH = 1024;

/**
 * The reasons an automatic driver can DECLINE to touch a row. A decline is
 * not a failure: nothing was written, nothing was launched, and the row stays
 * exactly as it was. The reason is carried (never swallowed) so the driver's
 * per-reason breakdown can say WHY a row was left alone (F13).
 */
export type SyncSkipReason =
  /** Another driver holds the issue right now (the shared claim). */
  | "inFlight"
  /** The issue is already `synced` — there is nothing left to do. */
  | "alreadySynced"
  /** The row is still inside its backoff window. */
  | "backoff"
  /** The issue has no launch-derived association an automatic driver may own. */
  | "noAssociation";

class SyncSkipped extends Error {
  constructor(readonly reason: SyncSkipReason, message: string) {
    super(message);
    this.name = "SyncSkipped";
  }
}

/**
 * How many attempts one ledger row gets before the driver stops touching it.
 * A row that reaches the bound is left for the operator: it is never deleted
 * and never silently forgotten.
 */
const MAX_RETRY_ATTEMPTS = 10;

/**
 * The retry ladder, in milliseconds.
 *
 * Every rung is ABOVE the periodic driver's tick (5 minutes), so the ladder
 * actually ENGAGES: with the tick and the ramp at the same scale the driver
 * re-hit a failing row on every tick and the "exponential" backoff never
 * grew. The measured cadence of a failing row is now roughly
 * 5 -> 15 -> 30 -> 60 -> 180 -> 360 minutes, so ten minutes of driver time
 * contains ONE retry instead of ten.
 */
const RETRY_BACKOFF_LADDER_MS = [
  5 * 60_000,    // 5 minutes
  15 * 60_000,   // 15 minutes
  30 * 60_000,   // 30 minutes
  60 * 60_000,   // 1 hour
  180 * 60_000,  // 3 hours
  360 * 60_000,  // 6 hours
] as const;

/**
 * A `rate_limited` (429) row waits at least this long: re-hitting a row that
 * Linear is already throttling sustains the rate limiting it is clearing.
 */
const RATE_LIMITED_MIN_BACKOFF_MS = 60 * 60_000;

/** The jitter added on top of a rung, as a fraction of the rung. */
const RETRY_BACKOFF_JITTER_RATIO = 0.5;

/**
 * How long a claim (the `syncing` marker) stays fresh. A Linear attempt makes
 * at most four requests of ten seconds each, so this lease comfortably
 * covers one attempt; a CRASHED attempt is reclaimed by the periodic driver
 * once the lease expires.
 */
const SYNC_CLAIM_LEASE_MS = 10 * 60_000;

/**
 * The delay before the next attempt of a row, with jitter.
 *
 * `attemptCount` is the number of attempts already made, so the first delay
 * is the first rung. The jitter (up to +50% of the rung) keeps a burst of
 * rows that failed together from re-hitting Linear in lockstep — and it is
 * always ADDED, so the delay never falls below the rung (and never below the
 * driver's tick).
 */
export function retryBackoffMs(attemptCount: number, errorCode: string | null = null): number {
  if (attemptCount <= 0) return 0;
  const index = Math.min(attemptCount - 1, RETRY_BACKOFF_LADDER_MS.length - 1);
  let base = RETRY_BACKOFF_LADDER_MS[index]!;
  if (errorCode === "rate_limited") base = Math.max(base, RATE_LIMITED_MIN_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * base * RETRY_BACKOFF_JITTER_RATIO);
  return base + jitter;
}

export const LINEAR_STATE_UPDATE_MUTATION = `mutation($issueId: String!, $stateId: String!) {
  issueStateUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}`;

type SyncOutcome = "synced" | "conflicted" | "retryable" | "authorization_required";

type SyncErrorCode = Infer<typeof syncErrorCode>;

/** Fixed, bounded classification of a thrown Linear failure message. Never leaks upstream text. */
export function classifyLinearSyncFailure(message: string):
  { code: SyncErrorCode; outcome: SyncOutcome } {
  if (/Linear request failed \(429\)/.test(message)) return { code: "rate_limited", outcome: "retryable" };
  if (/timed out/i.test(message)) return { code: "timed_out", outcome: "retryable" };
  if (/Linear request failed \(40[13]\)/.test(message)) {
    return { code: "authorization_required", outcome: "authorization_required" };
  }
  if (/workspace identity changed/i.test(message)) {
    return { code: "authorization_required", outcome: "authorization_required" };
  }
  if (/could not be reached|Linear request failed \(5\d\d\)/i.test(message)) {
    return { code: "unreachable", outcome: "retryable" };
  }
  if (/returned a different project than requested/i.test(message)) {
    return { code: "conflicted", outcome: "conflicted" };
  }
  return { code: "read_failed", outcome: "retryable" };
}

/**
 * Stored-OAuth token flow, identical in shape to `linearIssues.ts`
 * `linearAccessToken`: newest non-disconnected connection wins, expired and
 * revoked grants refuse, and the workspace binding is checked against the
 * mapped workspace before any GraphQL call. Returns null instead of throwing
 * when the grant is unavailable, so the caller records
 * `authorization_required` rather than crashing.
 */
async function linearSyncAccessToken(
  ctx: ActionCtx,
  owner: Owner,
  assertOwnerCurrent: () => Promise<unknown>,
  workspaceId: string,
): Promise<string | null> {
  const connections = await ctx.runQuery(internal.linearConnectionsStore.listConnections, {
    ...storeOwner(owner), now: Date.now(),
  });
  if (connections.length === 0) return null;
  const connection = connections[0]!;
  if (connection.status === "expired" || connection.status === "reauthorizationRequired") return null;
  const secret = await ctx.runQuery(internal.linearConnectionsStore.getConnectionSecret, {
    ...storeOwner(owner), connectionId: connection.connectionId, now: Date.now(),
  });
  if (!secret) return null;
  if (secret.workspaceId !== workspaceId) return null;
  try {
    await assertOwnerCurrent();
    return decryptLinearSecret(
      secret.accessTokenCiphertext, linearAccessPurpose(owner.issuer, owner.subject, secret.workspaceId));
  } catch {
    return null;
  }
}

/**
 * One issue read against Linear, classified. Throws nothing else; the
 * classification drives the ledger. A `different project` failure is "moved",
 * i.e. conflicted. A 200 WITH a GraphQL `errors` array is a PARTIAL read and
 * is never trusted — exactly as the mutation path treats a 200-with-errors
 * write (F3).
 */
class LinearStop extends Error {
  constructor(
    readonly outcome: SyncOutcome,
    readonly code: SyncErrorCode,
    readonly note: string,
  ) {
    super(`linear sync stop: ${note}`);
  }
}

async function readIssueDetail(
  ctx: ActionCtx,
  token: string,
  args: { projectId: string; workspaceId: string; issueId: string },
): Promise<LinearIssueDetail> {
  try {
    const read = await fetchLinearIssueDetail(token, args);
    if (read.errors.length > 0) {
      throw new LinearStop(
        "retryable",
        "graph_ql_errors",
        "The Linear issue read reported GraphQL errors; a partial read is never trusted. Nothing was written and the ledger stays uncertain.",
      );
    }
    return read.issue;
  } catch (error) {
    if (error instanceof LinearStop) throw error;
    const message = error instanceof Error ? error.message : "";
    const classified = classifyLinearSyncFailure(message);
    throw new LinearStop(
      classified.outcome,
      classified.code,
      `The Linear issue could not be read (${classified.code ?? "read_failed"}); nothing was written and the ledger stays uncertain.`,
    );
  }
}

/** Guard re-check reused for both the pre-mutation read and the post-mutation re-read. */
function terminalOrMovedGuard(issue: LinearIssueDetail, linearTeamId: string): LinearStop | null {
  if (issue.state.type === "completed") {
    return new LinearStop("conflicted", "conflicted", "The Linear issue is already Done; Helm never overwrites a completed issue and never sets Done itself.");
  }
  if (issue.state.type === "canceled") {
    return new LinearStop("conflicted", "conflicted", "The Linear issue is Canceled; Helm never overwrites a canceled issue.");
  }
  if (issue.team.id !== linearTeamId) {
    return new LinearStop("conflicted", "conflicted", "The Linear issue moved to another team; nothing was written.");
  }
  return null;
}

const syncArgs = {
  linearProjectId: v.string(),
  linearTeamId: v.string(),
  linearIssueId: v.string(),
};

const syncReturns = v.object({
  outcome: v.union(
    v.literal("synced"), v.literal("conflicted"),
    v.literal("retryable"), v.literal("authorization_required"),
  ),
  /** How many associations (each with its own ledger row) this sync covered. */
  associations: v.number(),
  attemptCount: v.union(v.number(), v.null()),
  targetStateId: v.union(v.string(), v.null()),
  targetStateName: v.union(v.string(), v.null()),
  observedStateId: v.union(v.string(), v.null()),
  observedStateName: v.union(v.string(), v.null()),
  /** Empty string means "no note"; null means the stop carries no note. */
  detail: v.union(v.string(), v.null()),
});

/**
 * Owner-gated Linear In Progress sync for one issue's accepted associations.
 * Returns a total outcome; never throws for a Linear-side condition.
 *
 * `mode` decides WHO is driving:
 *   - `manual`: the owner's deliberate `syncIssue` call. It may drive every
 *     association of the issue, manual links included.
 *   - `automatic`: the launch trigger and the periodic driver. An automatic
 *     path NEVER owns a manual association (`attemptId === ""`), NEVER
 *     re-drives a row inside its backoff window, and NEVER re-drives an
 *     issue that is already `synced` — and it CLAIMS the issue's ledger rows
 *     before it writes, so the two automatic drivers cannot write the same
 *     Linear issue twice in one window.
 *
 * `referenceNow` is the clock the driver reasons with (the periodic driver
 * passes its own `now` so one run has ONE consistent notion of time).
 */
async function performSync(
  ctx: ActionCtx,
  owner: Owner,
  args: { linearProjectId: string; linearTeamId: string; linearIssueId: string },
  mode: "manual" | "automatic" = "manual",
  referenceNow: number = Date.now(),
): Promise<Infer<typeof syncReturns>> {
  const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
    subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
  });

  const linearProjectId = args.linearProjectId.trim();
    const linearTeamId = args.linearTeamId.trim();
    const linearIssueId = args.linearIssueId.trim();
    if (linearProjectId.length === 0 || linearProjectId.length > MAX_ID_LENGTH ||
        linearTeamId.length === 0 || linearTeamId.length > MAX_ID_LENGTH ||
        linearIssueId.length === 0 || linearIssueId.length > MAX_ID_LENGTH) {
      throw new Error("Linear sync request is invalid");
    }
    await assertOwnerCurrent();

    // The enabled mapping is the configuration that carries this team's
    // chosen started state. Without it there is nothing team-specific to
    // resolve, and syncing an arbitrary state would be a hardcoded default.
    const mapping = await ctx.runQuery(internal.projectMappingsStore.resolveMappingForIssue, {
      ...storeOwner(owner), linearProjectId, linearTeamId,
    });
    if (!mapping) {
      throw new Error("No enabled mapping for this Linear project and team; sync is not configured.");
    }

    // The sync's write scope is bound to its resolved identity: only
    // associations of THIS issue under THIS (project, team). An association
    // of the same issue but another team or project is never marked synced
    // with this team's target state (F1).
    const allAssociations = await ctx.runQuery(
      internal.linearAssociationStore.associationsForIssue, {
        ...storeOwner(owner), linearIssueId, linearProjectId, linearTeamId,
      });
    // F3/F4: an AUTOMATIC path never owns a manual association. A manual
    // link (`attemptId === ""`) keeps its own ledger row, and no automatic
    // path may create, claim, or write it — the manual link stays bound
    // without any status-change request. This `attemptId` check is the
    // load-bearing mechanism; the ledger has no `provenance` column yet.
    const associations = mode === "automatic"
      ? allAssociations.filter((row) => row.attemptId !== "")
      : allAssociations;
    if (associations.length === 0) {
      if (mode === "automatic") {
        throw new SyncSkipped(
          "noAssociation",
          "This Linear issue has no launch-derived association an automatic driver may own.",
        );
      }
      throw new Error("This Linear issue has no accepted Helm launch to sync; record it first.");
    }
    const associationIds = associations.map((row) => row.associationId);

    if (mode === "automatic") {
      // (a) ALREADY SYNCED -> a strict no-op. No claim, no attempt counter,
      //     no network call, no write of any kind: a second driver that
      //     arrives after the first one finished must not touch the row.
      const ledgerRows = await ctx.runQuery(internal.linearSyncStore.ledgerRowsForAssociations, {
        ...storeOwner(owner), associationIds,
      });
      if (ledgerRows.length === associationIds.length && ledgerRows.every((row) => row.state === "synced")) {
        throw new SyncSkipped(
          "alreadySynced",
          "This Linear issue is already synced; nothing to do.",
        );
      }
      // (b) BACKOFF: a row that failed is not re-driven before its window
      //     elapses. Without this, a driver and a trigger could hammer the
      //     same issue (and a 429 row would re-hit the rate limiter that is
      //     already throttling Helm).
      const now = referenceNow;
      for (const row of ledgerRows) {
        if (row.state !== "retryable") continue;
        const backoff = retryBackoffMs(row.attemptCount, row.lastErrorCode ?? null);
        if (now - row.updatedAt < backoff) {
          throw new SyncSkipped(
            "backoff",
            "This Linear issue is still inside its retry backoff window.",
          );
        }
      }
    }

    // THE SHARED CONTENTION POINT: claim the issue's ledger rows (all of
    // them, in one transaction) before anything is written. A driver that
    // finds a fresh claim is refused and writes NOTHING.
    const claim = await ctx.runMutation(internal.linearSyncStore.claimSyncAttempt, {
      ...storeOwner(owner), associationIds, linearProjectId, linearTeamId,
      at: referenceNow, leaseMs: SYNC_CLAIM_LEASE_MS,
    });
    if (!claim.claimed) {
      throw new SyncSkipped(
        "inFlight",
        "Another sync is already in flight for this Linear issue; nothing was written.",
      );
    }
    const attemptCount = claim.attemptCount;

    // The ledger's last OBSERVED state before this attempt — the baseline for
    // detecting a human's deliberate state move (F6). `beginSyncAttempt` does
    // not clear it; the first store write below is what would.
    const baseline: { associationId: Id<"linearIssueThreads">; observedStateId: string | null; observedStateName: string | null }[] =
      await ctx.runQuery(internal.linearSyncStore.ledgerBaseline, { ...storeOwner(owner), associationIds });
    const baselineIds = [...new Set(baseline.map((row) => row.observedStateId).filter((id): id is string => id !== null))];
    const baselineName = baselineIds.length === 1
      ? (baseline.find((row) => row.observedStateId === baselineIds[0])?.observedStateName ?? baselineIds[0])
      : null;

    const stopWith = async (
      outcome: SyncOutcome,
      code: SyncErrorCode,
      targetState: { id: string | null; name: string | null },
      observedState: { id: string | null; name: string | null; type: string | null },
      note: string | null,
      // N1: human-intent conflicts hold the ledger's previous observed state
      // so the verdict stays sticky (the baseline is never renewed by them).
      holdObserved = false,
    ): Promise<Infer<typeof syncReturns>> => {
      await ctx.runMutation(internal.linearSyncStore.recordSyncOutcome, {
        ...storeOwner(owner), associationIds, linearProjectId, linearTeamId,
        state: outcome, errorCode: code,
        targetStateId: targetState.id, targetStateName: targetState.name,
        observedStateId: observedState.id, observedStateName: observedState.name, observedStateType: observedState.type,
        ...(holdObserved ? { holdObserved } : {}),
        ...(note === null ? {} : { note }), at: referenceNow,
      });
      return {
        outcome, associations: associationIds.length, attemptCount,
        targetStateId: targetState.id, targetStateName: targetState.name,
        observedStateId: observedState.id, observedStateName: observedState.name,
        detail: note,
      };
    };

    // The Linear grant must be live before anything else touches the network.
    const token = await linearSyncAccessToken(ctx, owner, assertOwnerCurrent, mapping.linearWorkspaceId);
    if (token === null) {
      return await stopWith("authorization_required", "authorization_required",
        { id: null, name: null }, { id: null, name: null, type: null },
        "The Linear connection is unavailable, expired, or was revoked; reconnect it to sync. Nothing crashed and nothing was launched.");
    }

    // Read the issue at least twice: once for the guard decision, then again
    // immediately before the mutation. Anything that changed in between is an
    // external change Helm must not overwrite.
    let firstRead: LinearIssueDetail;
    try {
      firstRead = await readIssueDetail(ctx, token, {
        projectId: linearProjectId, workspaceId: mapping.linearWorkspaceId, issueId: linearIssueId,
      });
    } catch (error) {
      const stop = error instanceof LinearStop ? error : new LinearStop("retryable", "read_failed", "The Linear issue could not be read.");
      return await stopWith(stop.outcome, stop.code, { id: null, name: null },
        { id: null, name: null, type: null }, stop.note);
    }
    await assertOwnerCurrent();
    const firstGuard = terminalOrMovedGuard(firstRead, linearTeamId);
    if (firstGuard) {
      return await stopWith(firstGuard.outcome, firstGuard.code, { id: null, name: null },
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type }, firstGuard.note);
    }

    // Team-specific target resolution: live workflow states of the issue's OWN
    // team, validated against the mapping's stored started-state id. Never a
    // global default and never another team's state.
    let targetState: { id: string; name: string };
    try {
      const { states } = await fetchLinearTeamStates(token, firstRead.team.id, mapping.linearWorkspaceId);
      const resolved = requireStartedState(states, mapping.startedStateId, firstRead.team.key);
      targetState = { id: resolved.id, name: resolved.name };
    } catch (error) {
      // A stale mapped started state is a CONFIGURATION stop: an immediate
      // retry would fail identically forever, so it is never filed `retryable`
      // (F7). The classification is carried by the typed error, not by regex
      // over the message.
      if (error instanceof LinearMisconfiguration) {
        return await stopWith("conflicted", "misconfigured", { id: null, name: null },
          { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
          "The team's chosen In Progress state is no longer valid in Linear; remap the project's started state. Nothing was written, and this is not a network failure to retry.");
      }
      const message = error instanceof Error ? error.message : "";
      const classified = classifyLinearSyncFailure(message);
      return await stopWith(classified.outcome, classified.code, { id: null, name: null },
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        `The team's workflow states could not be read (${classified.code ?? "read_failed"}); nothing was written.`);
    }

    // Already at the target: record observed truth, no mutation.
    if (firstRead.state.id === targetState.id) {
      return await stopWith("synced", null,
        { id: targetState.id, name: targetState.name },
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        "The issue is already in the team's In Progress state; no Linear write was needed.");
    }

    // A human's deliberate move since Helm last OBSERVED the issue is never
    // overwritten (F6, N2): ANY change away from the ledger's recorded
    // baseline — into another started state or back out of one — is human
    // intent. The verdict is STICKY (N1): the conflict holds the previous
    // baseline instead of advancing to the human's state, so every later
    // sync keeps refusing until the issue returns to the recorded state (or
    // the already-in-target shortcut fires).
    if (baselineIds.length > 1) {
      // Ambiguous observed history: the scoped associations disagree about
      // what was last observed. Fail closed (N3) — never skip, never write.
      return await stopWith("conflicted", "conflicted", targetState,
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        "The associations' recorded observed history is ambiguous; Helm will not decide which state was last intended. Nothing was written until the ledger is reconciled.", true);
    }
    if (baselineIds[0] !== undefined && baselineIds[0] !== firstRead.state.id) {
      return await stopWith("conflicted", "conflicted", targetState,
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        `The issue was last observed in ${baselineName ?? baselineIds[0]} and a human appears to have moved it to ${firstRead.state.name}; Helm never writes over a deliberate state change. Nothing was written, and later syncs keep refusing until the issue is back in the recorded state.`, true);
    }

    // Pre-mutation re-read: the two-read protocol. A mutation is only issued
    // when the second read still shows the guarded, unchanged issue.
    let secondRead: LinearIssueDetail;
    try {
      secondRead = await readIssueDetail(ctx, token, {
        projectId: linearProjectId, workspaceId: mapping.linearWorkspaceId, issueId: linearIssueId,
      });
    } catch (error) {
      const stop = error instanceof LinearStop ? error : new LinearStop("retryable", "read_failed", "The second Linear read failed before any write.");
      return await stopWith(stop.outcome, stop.code, targetState,
        { id: null, name: null, type: null }, stop.note);
    }
    const secondGuard = terminalOrMovedGuard(secondRead, linearTeamId);
    if (secondGuard) {
      return await stopWith(secondGuard.outcome, secondGuard.code, targetState,
        { id: secondRead.state.id, name: secondRead.state.name, type: secondRead.state.type },
        `${secondGuard.note} (detected on the pre-write re-read)`);
    }
    // A concurrent move INTO the target is not a conflict (N4): the issue is
    // exactly where Helm wants it, so record synced from observed truth with
    // no write — before any state-identity conflict check.
    if (secondRead.state.id === targetState.id) {
      return await stopWith("synced", null, targetState,
        { id: secondRead.state.id, name: secondRead.state.name, type: secondRead.state.type },
        "Between Helm's two reads the issue arrived in the team's In Progress state on its own; recorded synced from observed truth without any write.");
    }

    // PRIMARY conflict signal (F5): the state identity changed between the
    // two reads — an external state change that must never be overwritten.
    if (secondRead.state.id !== firstRead.state.id) {
      return await stopWith("conflicted", "conflicted", targetState,
        { id: secondRead.state.id, name: secondRead.state.name, type: secondRead.state.type },
        "The issue's state changed in Linear between Helm's two reads; nothing was written to avoid overwriting an external change.");
    }
    // SECONDARY: `updatedAt` moves on ANY issue change (comment, label,
    // assignee), so a cosmetic-only drift is no longer a conflict that
    // silently stalls the sync — the state-identity check above and the
    // post-write re-read protect everything meaningful. The write proceeds.
    void secondRead.updatedAt;

    // ---- The mutation. From here on, nothing is trusted until re-read. ----
    let mutationErrors = false;
    let uncertainWrite = false;
    let writeRejected = false;
    try {
      const response = await requestLinearGraphql(token, LINEAR_STATE_UPDATE_MUTATION, {
        issueId: linearIssueId, stateId: targetState.id,
      });
      // A DEFINITE field-level refusal: Linear answered with the structured
      // update result and reported it did NOT apply. This is checked before
      // any partial-error handling and needs no re-read to classify (F4).
      const data = response.data;
      const stateUpdate = data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).issueStateUpdate
        : undefined;
      if (stateUpdate && typeof stateUpdate === "object" &&
          (stateUpdate as Record<string, unknown>).success === false) {
        writeRejected = true;
      } else if (Array.isArray(response.errors) && response.errors.length > 0) {
        // HTTP 200 with a GraphQL errors array is FAILURE, never success.
        // Re-read purely for evidence; the ledger will NOT conclude synced
        // from this response.
        mutationErrors = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const classified = classifyLinearSyncFailure(message);
      if (classified.code === "rate_limited") {
        // 429 is a definite rejection: the request was never executed, so no
        // re-read is needed to classify the outcome.
        return await stopWith("retryable", "rate_limited", targetState,
          { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
          "Linear is rate limiting (429); nothing was written. Retry later with the same sync call.");
      }
      // A timeout or any other transport uncertainty: the write may or may
      // not have landed. Re-read and conclude from observed truth only.
      uncertainWrite = true;
    }
    if (writeRejected) {
      return await stopWith("conflicted", "write_rejected", targetState,
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        "Linear refused the In Progress update (success=false) without an error; a human or the team's workflow policy now owns this state. Nothing was concluded as synced and nothing retries automatically.");
    }

    let postRead: LinearIssueDetail | null = null;
    try {
      postRead = await readIssueDetail(ctx, token, {
        projectId: linearProjectId, workspaceId: mapping.linearWorkspaceId, issueId: linearIssueId,
      });
    } catch (error) {
      const stop = error instanceof LinearStop ? error : new LinearStop("retryable", "read_failed", "The post-write re-read failed.");
      // The mutation is still uncertain: it may have applied while Helm could
      // not observe it. Explicitly NOT synced; a later deliberate sync call
      // will re-read and conclude.
      return await stopWith("retryable", uncertainWrite ? "timed_out" : stop.code,
        targetState, { id: null, name: null, type: null },
        `${stop.note} The state write's outcome is unknown; nothing was concluded and nothing was relaunched.`);
    }

    const postGuard = terminalOrMovedGuard(postRead, linearTeamId);
    if (postGuard) {
      return await stopWith(postGuard.outcome, postGuard.code, targetState,
        { id: postRead.state.id, name: postRead.state.name, type: postRead.state.type },
        postGuard.note);
    }
    if (postRead.state.id === targetState.id) {
      if (mutationErrors) {
        // GraphQL errors on a 200 are never treated as success. The observed
        // state is recorded as evidence; the ledger stays retryable and a
        // clean subsequent sync (which will see the target state and skip the
        // write) is what records synced.
        return await stopWith("retryable", "graph_ql_errors", targetState,
          { id: postRead.state.id, name: postRead.state.name, type: postRead.state.type },
          "Linear reported GraphQL errors on the state write; not treated as success. A later sync that observes the target state records synced.");
      }
      return await stopWith("synced", null, targetState,
        { id: postRead.state.id, name: postRead.state.name, type: postRead.state.type },
        "The re-read observed the issue in the team's In Progress state after the write.");
    }
    // The mutation did not produce the target state. Never cycle further,
    // never write again blindly, and never conclude success.
    return await stopWith("retryable", mutationErrors ? "graph_ql_errors" : uncertainWrite ? "timed_out" : "unreachable",
      targetState, { id: postRead.state.id, name: postRead.state.name, type: postRead.state.type },
      "The write did not land as expected; recorded from the re-read's observed truth and left for a deliberate retry.");
}

export const syncIssue = action({
  args: syncArgs,
  returns: syncReturns,
  handler: async (ctx, args): Promise<Infer<typeof syncReturns>> => {
    const owner = await ctx.runQuery(internal.linearAssociationStore.ownerContext, {});
    return performSync(ctx, owner, args);
  },
});

const ledgerView = v.object({
  ledgerId: v.id("linearSyncLedger"),
  associationId: v.id("linearIssueThreads"),
  linearIssueId: v.string(),
  linearIssueIdentifier: v.string(),
  state: v.string(),
  attemptCount: v.number(),
  targetStateId: v.union(v.string(), v.null()),
  targetStateName: v.union(v.string(), v.null()),
  lastErrorCode: syncErrorCode,
  observedStateId: v.union(v.string(), v.null()),
  observedStateName: v.union(v.string(), v.null()),
  observedStateType: v.union(v.string(), v.null()),
  note: v.optional(v.string()),
});

/** Owner-gated operator read of the sync ledger for one issue. */
export const ledgerForIssue = action({
  args: { linearIssueId: v.string() },
  returns: v.array(ledgerView),
  handler: async (ctx, args): Promise<Infer<typeof ledgerView>[]> => {
    const owner = await ctx.runQuery(internal.linearAssociationStore.ownerContext, {});
    const linearIssueId = args.linearIssueId.trim();
    if (linearIssueId.length === 0 || linearIssueId.length > MAX_ID_LENGTH) {
      throw new Error("Linear sync request is invalid");
    }
    const associations = await ctx.runQuery(
      internal.linearAssociationStore.associationsForIssue, {
        ...storeOwner(owner), linearIssueId,
      });
    const output: Infer<typeof ledgerView>[] = [];
    for (const association of associations) {
      const row = await ctx.runQuery(internal.linearAssociationStore.ledgerForAssociation, {
        ...storeOwner(owner), associationId: association.associationId,
      });
      if (row === null) continue;
      output.push({
        ledgerId: row.ledgerId,
        associationId: row.associationId,
        linearIssueId,
        linearIssueIdentifier: association.linearIssueIdentifier,
        state: row.state,
        attemptCount: row.attemptCount,
        targetStateId: row.targetStateId,
        targetStateName: row.targetStateName,
        lastErrorCode: row.lastErrorCode ?? null,
        observedStateId: row.observedStateId,
        observedStateName: row.observedStateName,
        observedStateType: row.observedStateType,
        ...(row.note !== undefined && row.note !== null ? { note: row.note } : {}),
      });
    }
    return output;
  },
});

/** Each actionability class gets its OWN budget (N7): a wall of `pending`
 * rows can never starve `conflicted` / `authorization_required` / `retryable`
 * rows out of the operator queue. `syncing` (an attempt in flight) is listed
 * last: it needs no action, but a row that STUCK there (a crashed attempt)
 * must not be invisible. */
const OPEN_LEDGER_STATES = ["conflicted", "authorization_required", "retryable", "pending", "syncing"] as const;
const OPEN_LEDGER_BUDGET_PER_STATE = 200;

const openLedgerRow = v.object({
  ledgerId: v.id("linearSyncLedger"),
  associationId: v.id("linearIssueThreads"),
  linearIssueId: v.string(),
  linearIssueIdentifier: v.string(),
  linearTeamId: v.string(),
  state: v.string(),
  attemptCount: v.number(),
  targetStateId: v.union(v.string(), v.null()),
  targetStateName: v.union(v.string(), v.null()),
  lastErrorCode: syncErrorCode,
  observedStateId: v.union(v.string(), v.null()),
  observedStateName: v.union(v.string(), v.null()),
  note: v.optional(v.string()),
});

const recordingFailureRow = v.object({
  attemptId: v.string(),
  issueKey: v.string(),
  issueIdentifier: v.union(v.string(), v.null()),
  attemptState: v.string(),
  note: v.string(),
});

/**
 * Owner-gated view of the OPERATOR WORK QUEUE, backed by the `by_state`
 * index (no table scan): every ledger row of THIS owner that is not `synced`
 * and still needs a deliberate `syncIssue` / operator decision, ORDERED BY
 * ACTIONABILITY (N7) — `conflicted` and `authorization_required` first,
 * `retryable` next, `pending` last, and `syncing` (an attempt in flight)
 * after it, each within its own per-state budget.
 *
 * Also lists REFUSED association recordings (N6): launch attempts the launch
 * path marked `association recording failed (...)` — these have no ledger row
 * to list, so they would otherwise be undiscoverable.
 *
 * Listing is what the operator does BEFORE deciding to call `syncIssue` for
 * `conflicted` / `authorization_required` rows. The automatic drivers OWN
 * only `pending` / `retryable` rows, they never launch native work, and
 * they leave every row they do not own exactly as it was.
 */
export const openLedger = action({
  args: {},
  returns: v.object({
    open: v.array(openLedgerRow),
    recordingFailures: v.array(recordingFailureRow),
  }),
  handler: async (ctx): Promise<{ open: Infer<typeof openLedgerRow>[]; recordingFailures: Infer<typeof recordingFailureRow>[] }> => {
    const owner = await ctx.runQuery(internal.linearAssociationStore.ownerContext, {});
    const open: Infer<typeof openLedgerRow>[] = [];
    for (const state of OPEN_LEDGER_STATES) {
      if (open.length >= OPEN_LEDGER_BUDGET_PER_STATE * OPEN_LEDGER_STATES.length) break;
      const rows = await ctx.runQuery(internal.linearSyncStore.openLedgerRows, {
        ...storeOwner(owner), state,
        limit: OPEN_LEDGER_BUDGET_PER_STATE,
      });
      for (const row of rows) {
        if (open.length >= OPEN_LEDGER_BUDGET_PER_STATE * OPEN_LEDGER_STATES.length) break;
        open.push({
          ledgerId: row.ledgerId,
          associationId: row.associationId,
          linearIssueId: row.linearIssueId,
          linearIssueIdentifier: row.linearIssueIdentifier,
          linearTeamId: row.linearTeamId,
          state: row.state,
          attemptCount: row.attemptCount,
          targetStateId: row.targetStateId,
          targetStateName: row.targetStateName,
          lastErrorCode: row.lastErrorCode,
          observedStateId: row.observedStateId,
          observedStateName: row.observedStateName,
          ...(row.note !== undefined && row.note !== null ? { note: row.note } : {}),
        });
      }
    }
    const output = {
      open,
      recordingFailures: await ctx.runQuery(internal.linearAssociationStore.recordingFailureRows, {
        limit: OPEN_LEDGER_BUDGET_PER_STATE,
      }),
    };
    return output;
  },
});

/**
 * The IMMEDIATE trigger: the sync the launch path schedules
 * (`ctx.scheduler.runAfter(0, ...)`) right after it records a NEW
 * association. It drives in `automatic` mode, so it:
 *   - never owns a manual association (`attemptId === ""`);
 *   - never re-drives an issue that is already `synced` (a strict no-op);
 *   - never re-drives a row inside its backoff window;
 *   - CLAIMS the issue's ledger rows first, so the periodic driver cannot
 *     write the same issue in the same window.
 *
 * Every outcome is swallowed on purpose: a scheduled sync can never alter a
 * launch result, and a declined sync (in flight, already synced, backoff) is
 * a normal state, not an error.
 */
export const runScheduledSync = internalAction({
  args: {
    subject: v.string(),
    ownerIssuer: v.string(),
    revision: v.number(),
    linearProjectId: v.string(),
    linearTeamId: v.string(),
    linearIssueId: v.string(),
  },
  returns: v.union(syncReturns, v.null()),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, issuer: args.ownerIssuer, revision: args.revision };
    try {
      await ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
      });
    } catch {
      return null;
    }
    try {
      return await performSync(ctx, owner, {
        linearProjectId: args.linearProjectId,
        linearTeamId: args.linearTeamId,
        linearIssueId: args.linearIssueId,
      }, "automatic");
    } catch {
      // A declined or failed automatic sync leaves the ledger exactly as it
      // was; the periodic driver owns the recovery.
      return null;
    }
  },
});

/**
 * The states the periodic driver OWNS. `pending` is owned too: a `pending`
 * row is an association whose sync never completed, so a DROPPED or FAILED
 * trigger is genuinely recovered by this driver instead of sitting forever.
 * `syncing` is read only to RECLAIM a row whose claim lease expired (a
 * crashed attempt); a fresh `syncing` row belongs to the driver that is
 * working on it right now.
 */
const DRIVER_STATES = ["pending", "retryable", "syncing"] as const;

/** The driver's count bound: how many rows one run may attempt. */
const DEFAULT_DRIVER_BATCH_LIMIT = 25;

/**
 * The driver's TIME bound: one run never spends more than this inside the
 * action. A single attempt makes at most four Linear requests of ten
 * seconds each, so the worst case per row is ~40s; the budget keeps the
 * whole action far below the Convex action limit.
 */
const DEFAULT_DRIVER_TIME_BUDGET_MS = 60_000;

/** How many rows one driver page may hold. */
const DRIVER_PAGE_SIZE = 50;

/** How many pages one driver run may walk per state. */
const DRIVER_MAX_PAGES = 4;

/** One row of the driver's fair-queue read. */
type DriverRow = {
  ledgerId: Id<"linearSyncLedger">;
  associationId: Id<"linearIssueThreads">;
  ownerSubject: string;
  ownerIssuer: string;
  ownerRevision: number;
  state: string;
  attemptCount: number;
  updatedAt: number;
  lastErrorCode: SyncErrorCode;
};

const driverSkipReasons = v.object({
  /** The row reached `MAX_RETRY_ATTEMPTS`: it is left for the operator. */
  bound: v.number(),
  /** The row is still inside its backoff window. */
  backoff: v.number(),
  /** The association is a MANUAL link (`attemptId === ""`): never driven. */
  manual: v.number(),
  /** The owner's grant is gone: the row is left for the operator. */
  noGrant: v.number(),
  /** Another row of the same issue was already driven in this run. */
  duplicate: v.number(),
  /** Another driver holds the issue right now (the shared claim). */
  inFlight: v.number(),
  /** The issue is already `synced`: nothing to do. */
  alreadySynced: v.number(),
  /** The issue has no launch-derived association an automatic driver may own. */
  noAssociation: v.number(),
  /** Anything else: the row keeps its state and is retried later. */
  error: v.number(),
});

/**
 * The PERIODIC driver: the cron (`convex/crons.ts`) re-drives the ledger
 * rows it owns with bounded backoff.
 *
 * Its guarantees:
 *   - it owns `pending` and `retryable` rows only, and never launches
 *     native work;
 *   - it walks the queue in `(state, updatedAt)` order with a cursor, so the
 *     least-recently-touched row goes first and later rows cannot starve;
 *   - it is bounded by COUNT and by TIME, so one run can never exceed the
 *     action limit;
 *   - it reports WHY every row was left alone (F13): the per-reason
 *     breakdown is part of the return value, not a discarded counter.
 */
export const driveRetryable = internalAction({
  args: {
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
    timeBudgetMs: v.optional(v.number()),
  },
  returns: v.object({
    /** Rows this run actually attempted. */
    processed: v.number(),
    /** Of those, the ones that reached `synced`. */
    succeeded: v.number(),
    /** Rows this run left alone, broken down by reason. */
    skipped: driverSkipReasons,
    /** The total of `skipped`. */
    skippedTotal: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const startedAt = Date.now();
    const timeBudgetMs = Math.max(0, args.timeBudgetMs ?? DEFAULT_DRIVER_TIME_BUDGET_MS);
    const batchLimit = Math.max(1, Math.min(args.limit ?? DEFAULT_DRIVER_BATCH_LIMIT, 100));
    const reasons = {
      bound: 0, backoff: 0, manual: 0, noGrant: 0, duplicate: 0,
      inFlight: 0, alreadySynced: 0, noAssociation: 0, error: 0,
    };
    let processed = 0;
    let succeeded = 0;
    let skippedTotal = 0;
    const seen = new Set<string>();
    const outOfBudget = () => Date.now() - startedAt >= timeBudgetMs;

    for (const state of DRIVER_STATES) {
      let cursor: string | null = null;
      for (let page = 0; page < DRIVER_MAX_PAGES; page += 1) {
        if (outOfBudget() || processed >= batchLimit) break;
        const read: { rows: DriverRow[]; continueCursor: string | null; isDone: boolean } =
          await ctx.runQuery(internal.linearSyncStore.driverRows, {
            state,
            paginationOpts: { cursor, numItems: DRIVER_PAGE_SIZE },
          });
        for (const row of read.rows) {
          if (outOfBudget() || processed >= batchLimit) break;
          // A row the driver does not own is left alone, and the reason is
          // counted: a discarded counter is how a driver ends up silently
          // doing nothing.
          if (row.state === "syncing" && now - row.updatedAt < SYNC_CLAIM_LEASE_MS) {
            reasons.inFlight += 1; skippedTotal += 1; continue;
          }
          if (row.state !== "pending" && row.state !== "retryable" && row.state !== "syncing") {
            reasons.error += 1; skippedTotal += 1; continue;
          }
          if (row.attemptCount >= MAX_RETRY_ATTEMPTS) {
            reasons.bound += 1; skippedTotal += 1; continue;
          }
          // The backoff ladder applies to `retryable` rows AND to reclaimed
          // `syncing` rows (a crashed attempt is a failed attempt).
          if (row.state === "retryable" || row.state === "syncing") {
            const backoff = retryBackoffMs(row.attemptCount, row.lastErrorCode ?? null);
            if (now - row.updatedAt < backoff) {
              reasons.backoff += 1; skippedTotal += 1; continue;
            }
          }
          // A MANUAL link (`attemptId === ""`) is never owned by an automatic
          // driver. This `attemptId` check is the load-bearing mechanism.
          const assoc = await ctx.runQuery(internal.linearAssociationStore.associationById, {
            associationId: row.associationId,
          });
          if (!assoc || assoc.attemptId === "") {
            reasons.manual += 1; skippedTotal += 1; continue;
          }
          const revision = await ctx.runQuery(internal.auth.activeGrantRevision, {
            subject: row.ownerSubject, issuer: row.ownerIssuer,
          });
          if (revision === null) {
            reasons.noGrant += 1; skippedTotal += 1; continue;
          }
          const owner = { subject: row.ownerSubject, issuer: row.ownerIssuer, revision };
          // One attempt per ISSUE per run: two associations of the same
          // issue are one Linear issue and one write.
          const dedupKey = `${row.ownerSubject}|${assoc.linearProjectId}|${assoc.linearTeamId}|${assoc.linearIssueId}`;
          if (seen.has(dedupKey)) {
            reasons.duplicate += 1; skippedTotal += 1; continue;
          }
          seen.add(dedupKey);
          try {
            const outcome = await performSync(ctx, owner, {
              linearProjectId: assoc.linearProjectId,
              linearTeamId: assoc.linearTeamId,
              linearIssueId: assoc.linearIssueId,
            }, "automatic", now);
            processed += 1;
            if (outcome.outcome === "synced") succeeded += 1;
          } catch (error) {
            if (error instanceof SyncSkipped) {
              reasons[error.reason] += 1;
            } else {
              reasons.error += 1;
            }
            skippedTotal += 1;
          }
        }
        if (read.isDone || read.continueCursor === null) break;
        cursor = read.continueCursor;
      }
      if (outOfBudget() || processed >= batchLimit) break;
    }
    return { processed, succeeded, skipped: reasons, skippedTotal };
  },
});
