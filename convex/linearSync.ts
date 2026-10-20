"use node";

import { v, type Infer } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

import { decryptLinearSecret, linearAccessPurpose } from "./lib/linearHelpers";
import { fetchLinearIssueDetail, type LinearIssueDetail } from "./lib/linearIssues";
import {
  fetchLinearTeamStates,
  requestLinearGraphql,
  requireStartedState,
} from "./lib/linearGraphql";

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
 *      loses the fact that an attempt was made.
 *   2. The target state is resolved from the issue's OWN team by a live
 *      workflow-states read, validated with `requireStartedState` — never a
 *      hardcoded name and never another team's state.
 *   3. Guards NEVER overwrite: an issue that is Done, Canceled, moved to
 *      another team, or externally changed between Helm's two reads is
 *      recorded `conflicted` and left untouched.
 *   4. A mutation is ALWAYS uncertain until proven otherwise: HTTP 200 with a
 *      GraphQL `errors` array is failure (not success), a timeout is
 *      uncertainty — and in both cases the issue is RE-READ before the ledger
 *      concludes anything. Only the re-read's observed truth can produce
 *      `synced`.
 *   5. Linear `429` is a definite rejection: recorded `retryable`
 *      (`rate_limited`) without touching the issue, and retried only by a
 *      later, deliberate sync call.
 *   6. Sync and execution are independent: this module issues NO T3 calls and
 *      can never relaunch a thread. Every failure stays on the ledger.
 */

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const MAX_ID_LENGTH = 1024;

export const LINEAR_STATE_UPDATE_MUTATION = `mutation($issueId: String!, $stateId: String!) {
  issueStateUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}`;

type SyncOutcome = "synced" | "conflicted" | "retryable" | "authorization_required";

const syncErrorCode = v.union(
  v.literal("rate_limited"),
  v.literal("timed_out"),
  v.literal("graph_ql_errors"),
  v.literal("conflicted"),
  v.literal("authorization_required"),
  v.literal("read_failed"),
  v.literal("unreachable"),
  v.null(),
);
type SyncErrorCode = "rate_limited" | "timed_out" | "graph_ql_errors" | "conflicted" | "authorization_required" | "read_failed" | "unreachable" | null;

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
 * One issue read against Linear, classified. Throws nothing; the classification
 * drives the ledger. A `different project` failure is "moved", i.e. conflicted.
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
    const detail = await fetchLinearIssueDetail(token, args);
    return detail.issue;
  } catch (error) {
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
 */
export const syncIssue = action({
  args: syncArgs,
  returns: syncReturns,
  handler: async (ctx, args): Promise<Infer<typeof syncReturns>> => {
    const owner = await ctx.runQuery(internal.linearAssociationStore.ownerContext, {});
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

    const associations: { associationId: Id<"linearIssueThreads"> }[] = await ctx.runQuery(
      internal.linearAssociationStore.associationsForIssue, {
        ...storeOwner(owner), linearIssueId,
      });
    if (associations.length === 0) {
      throw new Error("This Linear issue has no accepted Helm launch to sync; record it first.");
    }
    const associationIds = associations.map((row) => row.associationId);
    const attemptCount = await ctx.runMutation(internal.linearSyncStore.beginSyncAttempt, {
      ...storeOwner(owner), associationIds, at: Date.now(),
    });

    const stopWith = async (
      outcome: SyncOutcome,
      code: SyncErrorCode,
      targetState: { id: string | null; name: string | null },
      observedState: { id: string | null; name: string | null; type: string | null },
      note: string | null,
    ): Promise<Infer<typeof syncReturns>> => {
      await ctx.runMutation(internal.linearSyncStore.recordSyncOutcome, {
        ...storeOwner(owner), associationIds, state: outcome, errorCode: code,
        targetStateId: targetState.id, targetStateName: targetState.name,
        observedStateId: observedState.id, observedStateName: observedState.name, observedStateType: observedState.type,
        ...(note === null ? {} : { note }), at: Date.now(),
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
      const message = error instanceof Error ? error.message : "";
      const classified = classifyLinearSyncFailure(message);
      const note = /not a started workflow state|no started workflow state/.test(message)
        ? "The team's chosen In Progress state is no longer valid in Linear; remap the project's started state. Nothing was written."
        : `The team's workflow states could not be read (${classified.code ?? "read_failed"}); nothing was written.`;
      return await stopWith(classified.outcome, classified.code, { id: null, name: null },
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type }, note);
    }

    // Already at the target: record observed truth, no mutation.
    if (firstRead.state.id === targetState.id) {
      return await stopWith("synced", null,
        { id: targetState.id, name: targetState.name },
        { id: firstRead.state.id, name: firstRead.state.name, type: firstRead.state.type },
        "The issue is already in the team's In Progress state; no Linear write was needed.");
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
    if (secondRead.updatedAt !== firstRead.updatedAt) {
      return await stopWith("conflicted", "conflicted", targetState,
        { id: secondRead.state.id, name: secondRead.state.name, type: secondRead.state.type },
        "The issue changed in Linear between Helm's two reads; nothing was written to avoid overwriting an external change.");
    }

    // ---- The mutation. From here on, nothing is trusted until re-read. ----
    let mutationErrors = false;
    let uncertainWrite = false;
    try {
      const response = await requestLinearGraphql(token, LINEAR_STATE_UPDATE_MUTATION, {
        issueId: linearIssueId, stateId: targetState.id,
      });
      if (Array.isArray(response.errors) && response.errors.length > 0) {
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

