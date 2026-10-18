"use node";

import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { decryptStoredToken, operateToolCall } from "./t3OAuth";
import {
  LAUNCH_ABANDONED_RETRY,
  LAUNCH_PAYLOAD_MISMATCH,
  LAUNCH_REQUEST_INVALID,
  LAUNCH_SUBAGENTS_UNSUPPORTED,
  throwLaunchInvalid,
} from "./lib/launchErrors";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

/**
 * Explicit failure vocabulary for the native launch path. Every returned
 * failure carries one of these codes plus a fixed sanitized sentence — never
 * raw upstream text and never a token. Request-shape refusals (bad ids,
 * subagent preference, payload mismatch, abandoned retry) are thrown as
 * invalid-request errors instead; see `convex/lib/launchErrors.ts`.
 */
const launchReason = v.union(
  v.literal("authorization_required"),
  v.literal("expired"),
  v.literal("unreachable"),
  v.literal("rate_limited"),
  v.literal("model_unavailable"),
  v.literal("ambiguous"),
  v.literal("read_failed"),
);
type LaunchReason = Infer<typeof launchReason>;

const launchReturns = v.object({
  outcome: v.union(v.literal("launched"), v.literal("blocked"), v.literal("in_progress"), v.literal("ambiguous")),
  /** Null unless the outcome is `blocked` or `ambiguous`. */
  reason: v.union(launchReason, v.null()),
  /** Fixed sanitized sentence; safe to render. */
  detail: v.string(),
  attemptId: v.union(v.string(), v.null()),
  correlationKey: v.union(v.string(), v.null()),
  threadId: v.union(v.string(), v.null()),
  /** Always false: this path never authorizes a relaunch. */
  relaunchAuthorized: v.literal(false),
});
type LaunchResult = Infer<typeof launchReturns>;

type LaunchArgs = {
  attemptId: string;
  linearProjectId: string;
  linearTeamId: string;
  /** Linear issue id (a UUID): the per-issue attempt-lock key. */
  linearIssueId: string;
  /** Human-readable Linear issue identifier (e.g. "EGA-681"): branch slug only. */
  linearIssueIdentifier: string;
  prompt: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  useSubagents: boolean;
  subagentModel?: string;
};

type MappingView = {
  t3ConnectionId: Id<"t3Connections">;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ProjectTitle: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
  linearWorkspaceId: string;
};

type OperateConnection = {
  connectionId: Id<"t3Connections">;
  endpoint: string;
  environmentId: string;
  access: string;
  tokenCiphertext: string;
  credentialVersion: number;
};

/**
 * Narrow structural view over the `t3OAuth.read` union: the annotation keeps
 * this module's inferred type from feeding back into the `api` namespace (see
 * `convex/_generated/ai/guidelines.md`), and every union variant overlaps it.
 */
type T3ReadPage = {
  providers?: unknown;
  runtimeMode?: unknown;
  freshness?: unknown;
  environmentId?: unknown;
  items?: unknown;
  thread?: unknown;
  projectId?: unknown;
  nextCursor?: unknown;
  total?: unknown;
};

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Linear issue id and human-readable identifier: bounded charset, 1..128. */
const LINEAR_ISSUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const LINEAR_ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function invalid(): never {
  return throwLaunchInvalid(LAUNCH_REQUEST_INVALID);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid();
  return value as string;
}

/** Deterministic worktree branch for one attempt id, so a retry reuses it. */
function branchForAttempt(issueIdentifier: string, attemptId: string): string {
  const slug = issueIdentifier.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32) || "issue";
  const suffix = createHash("sha256").update(attemptId).digest("hex").slice(0, 8);
  return `helm/${slug}-${suffix}`;
}

/**
 * Canonical payload hash (M-2). Binds the attempt id to the exact meaning of
 * the launch: destination, model, mode, prompt and workspace strategy. The
 * thread title is intentionally EXCLUDED — it carries the random correlation
 * key minted at reservation time, which no retrier could know in advance.
 */
function canonicalPayloadHash(input: {
  issueKey: string;
  t3ProjectId: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  prompt: string;
  baseRef: string;
  branch: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "t3_thread_launch",
        "v1",
        input.issueKey,
        input.t3ProjectId,
        input.providerInstanceId,
        input.model,
        input.runtimeMode,
        "default",
        input.prompt,
        { type: "worktree", baseRef: input.baseRef, branch: input.branch, startFromOrigin: false },
      ]),
    )
    .digest("hex");
}

function launched(result: Omit<LaunchResult, "relaunchAuthorized">): LaunchResult {
  return { ...result, relaunchAuthorized: false as const };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

/**
 * Owner-gated native T3 worktree-thread launch (EGA-681 D07).
 *
 * Order is deliberate:
 *   0. owner grant gate — no work and no external access without it;
 *   1. validate the reviewed payload shape (no network);
 *   2. resolve the enabled mapping (unmapped/disabled refuses with a reason);
 *   3. require the separately-authorised `operate` connection on the same
 *      environment (anything else refuses BEFORE any network call);
 *   4. verify the Linear issue against authoritative Linear data — it must
 *      exist and its project and team must match the mapping — BEFORE any
 *      reservation or dispatch. An unverifiable connection fails closed;
 *   5. validate the model against the LIVE `orchestrator_capabilities` read;
 *   6. reserve the durable attempt BEFORE the launch call;
 *   7. launch exactly once via the write allowlist (`t3_thread_launch` only);
 *   8. acknowledge, or reconcile by correlation key on an unclear answer.
 *
 * Recovery rules (reused from `convex/launchAttempts.ts`, never from the
 * isolated bearer-token runtime in `convex/dispatch.ts`): a retry presents the
 * same attemptId and payloadHash and the stored row decides — a settled
 * attempt returns its thread without a second remote call; zero or many
 * reconciliation matches stay ambiguous and NEVER relaunch. A failed Linear
 * sync must never trigger another launch: this action performs NO Linear
 * mutation at all, so any future post-launch Linear step must run strictly
 * after `markAcknowledged` and must never reach the launch tool.
 */
export const launch = action({
  args: {
    attemptId: v.string(),
    linearProjectId: v.string(),
    linearTeamId: v.string(),
    linearIssueId: v.string(),
    linearIssueIdentifier: v.string(),
    prompt: v.string(),
    providerInstanceId: v.string(),
    model: v.string(),
    runtimeMode: v.string(),
    useSubagents: v.boolean(),
    subagentModel: v.optional(v.string()),
  },
  returns: launchReturns,
  handler: async (ctx: ActionCtx, args: LaunchArgs): Promise<LaunchResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });

    // 1. Shape checks fail before any database or network access.
    if (!ATTEMPT_ID_PATTERN.test(args.attemptId)) invalid();
    const linearProjectId = boundedText(args.linearProjectId.trim(), 1024);
    const linearTeamId = boundedText(args.linearTeamId.trim(), 1024);
    if (!LINEAR_ISSUE_ID_PATTERN.test(args.linearIssueId)) invalid();
    if (!LINEAR_ISSUE_IDENTIFIER_PATTERN.test(args.linearIssueIdentifier)) invalid();
    const linearIssueId = args.linearIssueId;
    const linearIssueIdentifier = args.linearIssueIdentifier;
    const prompt = boundedText(args.prompt, 30000);
    const providerInstanceId = boundedText(args.providerInstanceId, 256);
    const model = boundedText(args.model, 256);
    const runtimeMode = boundedText(args.runtimeMode, 64);
    if (args.useSubagents) return throwLaunchInvalid(LAUNCH_SUBAGENTS_UNSUPPORTED);
    if (args.subagentModel !== undefined && (typeof args.subagentModel !== "string" || args.subagentModel.length > 256)) {
      invalid();
    }
    await assertOwnerCurrent();

    // 2. Enabled mapping for the issue's (project, team) pair. Disabled
    // mappings never resolve; the row itself is left untouched.
    const mapping: MappingView | null = await ctx.runQuery(
      internal.projectMappingsStore.resolveMappingForIssue,
      { ...storeOwner(owner), linearProjectId, linearTeamId },
    );
    if (!mapping) {
      return launched({
        outcome: "blocked" as const,
        reason: "authorization_required" as LaunchReason,
        detail: "No enabled mapping for this Linear project and team; map it first.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }

    // 3. The separately-authorised operate connection. A read-only connection
    // can never satisfy this step — the check below refuses it before any
    // network call, and `operateToolCall` re-checks at the tool boundary.
    const connections: { connectionId: Id<"t3Connections">; access: string; status: string; environmentId: string }[] =
      await ctx.runQuery(internal.t3ConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
    const operateRows = connections.filter((row) => row.access === "operate");
    if (operateRows.length > 1) {
      return launched({
        outcome: "blocked" as const,
        reason: "authorization_required" as LaunchReason,
        detail: "T3 operate connection identity is ambiguous; disconnect the extra grant and try again.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    const operateRef = operateRows[0] ?? null;
    if (!operateRef) {
      return launched({
        outcome: "blocked" as const,
        reason: "authorization_required" as LaunchReason,
        detail: "T3 operate access has not been granted; complete the operate consent first.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    if (operateRef.status === "expired") {
      return launched({
        outcome: "blocked" as const, reason: "expired" as LaunchReason,
        detail: "T3 connection has expired; reconnect it to continue.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    if (operateRef.status === "reauthorizationRequired") {
      return launched({
        outcome: "blocked" as const, reason: "authorization_required" as LaunchReason,
        detail: "T3 authorization was revoked; reconnect to continue.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    if (operateRef.status === "unreachable") {
      return launched({
        outcome: "blocked" as const, reason: "unreachable" as LaunchReason,
        detail: "T3 connection is unreachable; refresh it before launching.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    if (operateRef.status !== "connected") {
      return launched({
        outcome: "blocked" as const, reason: "read_failed" as LaunchReason,
        detail: "T3 operate connection is not usable; reconnect it to continue.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    // The mapping's destination must live in the operate grant's environment.
    // The stored environment id is compared, never a caller-supplied value.
    if (mapping.t3EnvironmentId !== operateRef.environmentId) {
      return launched({
        outcome: "blocked" as const, reason: "authorization_required" as LaunchReason,
        detail: "The project mapping points at a different T3 environment than the operate connection; remap it first.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }

    const secret: (OperateConnection & { status: string; credentialVersion: number }) | null = await ctx.runQuery(
      internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: operateRef.connectionId, now: Date.now() },
    );
    if (!secret || secret.access !== "operate") {
      return launched({
        outcome: "blocked" as const, reason: "authorization_required" as LaunchReason,
        detail: "T3 operate access is unavailable; complete the operate consent first.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    if (secret.status !== "connected") {
      const reason: LaunchReason =
        secret.status === "expired" ? "expired" : secret.status === "unreachable" ? "unreachable" : "authorization_required";
      const detail =
        reason === "expired"
          ? "T3 connection has expired; reconnect it to continue."
          : reason === "unreachable"
            ? "T3 connection is unreachable; refresh it before launching."
            : "T3 authorization was revoked; reconnect to continue.";
      return launched({ outcome: "blocked" as const, reason, detail, attemptId: null, correlationKey: null, threadId: null });
    }

    const assertConnectionCurrent = (): Promise<boolean> =>
      ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, {
        ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
      });
    /**
     * L-1 checkpoints: the owner grant is revalidated BEFORE the MCP
     * transport is constructed (the bearer token is transmitted during
     * initialization) and again immediately before the tool call itself.
     */
    const guards = {
      beforeConnect: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the launch was in progress");
      },
      beforeCall: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the launch was in progress");
      },
    };
    const markReauthorizationRequired = (): Promise<null> =>
      ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
        at: Date.now(), status: "reauthorizationRequired", errorCode: "authorization_required",
      });

    // 4. Verify the issue against authoritative Linear data BEFORE any
    // reservation or dispatch. The mapping is per (project, team); the lock
    // is per issue id. A project/team mismatch refuses with a specific
    // reason; an unusable Linear connection fails closed — never launch on
    // an unverified issue. This action performs no Linear mutation. It runs
    // after the operate-connection gates so those refusals keep their
    // reasons, and before the first T3 network call.
    let verifiedIssueIdentifier: string;
    try {
      const linear = await ctx.runAction(api.linearIssues.read, {
        projectId: linearProjectId,
        issueId: linearIssueId,
      });
      if (linear.issue.id !== linearIssueId || linear.issue.team.id !== linearTeamId) {
        return launched({
          outcome: "blocked" as const,
          reason: "authorization_required" as LaunchReason,
          detail: "This Linear issue is not in the mapped project and team; pick an issue from the mapped project and team.",
          attemptId: null, correlationKey: null, threadId: null,
        });
      }
      verifiedIssueIdentifier = linear.issue.identifier;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/different project|not available for browsing|not in the mapped project/i.test(message)) {
        return launched({
          outcome: "blocked" as const,
          reason: "authorization_required" as LaunchReason,
          detail: "This Linear issue is not in the mapped project and team; pick an issue from the mapped project and team.",
          attemptId: null, correlationKey: null, threadId: null,
        });
      }
      return launched({
        outcome: "blocked" as const, reason: "read_failed" as LaunchReason,
        detail: "The Linear issue could not be verified; reconnect Linear and try again.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    // The client-supplied identifier is shape-checked above so the wire
    // contract carries the real issue identity end to end; the branch and
    // the stored evidence always use the authoritative Linear identifier.
    void linearIssueIdentifier;

    // 5. The model must be advertised by the LIVE catalog read. A stored or
    // caller-supplied catalogue is never trusted.
    await assertOwnerCurrent();
    let catalogProviders: { providerInstanceId: string; models: { id: string }[] }[];
    try {
      const capabilities: T3ReadPage = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "capabilities",
        input: {},
      });
      if (!Array.isArray(capabilities.providers)) throw new Error("T3 catalog could not be read");
      catalogProviders = capabilities.providers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("T3 catalog could not be read");
        const provider = entry as Record<string, unknown>;
        if (typeof provider.providerInstanceId !== "string") throw new Error("T3 catalog could not be read");
        if (!Array.isArray(provider.models)) throw new Error("T3 catalog could not be read");
        return {
          providerInstanceId: provider.providerInstanceId,
          models: (provider.models as unknown[]).map((modelEntry) => {
            if (!modelEntry || typeof modelEntry !== "object" || Array.isArray(modelEntry)) {
              throw new Error("T3 catalog could not be read");
            }
            const candidate = (modelEntry as Record<string, unknown>).id;
            if (typeof candidate !== "string") throw new Error("T3 catalog could not be read");
            return { id: candidate };
          }),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/T3 request failed \((401|403)\)/.test(message)) {
        await markReauthorizationRequired();
        return launched({
          outcome: "blocked" as const, reason: "authorization_required" as LaunchReason,
          detail: "T3 authorization was revoked; reconnect to continue.",
          attemptId: null, correlationKey: null, threadId: null,
        });
      }
      if (/T3 request failed \(429\)/.test(message)) {
        await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
          ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
          at: Date.now(), errorCode: "rate_limited",
        });
        return launched({
          outcome: "blocked" as const, reason: "rate_limited" as LaunchReason,
          detail: "T3 is receiving too many requests; try again shortly.",
          attemptId: null, correlationKey: null, threadId: null,
        });
      }
      if (/could not be reached|timed out|T3 request failed \(5\d\d\)/i.test(message)) {
        return launched({
          outcome: "blocked" as const, reason: "unreachable" as LaunchReason,
          detail: "The T3 endpoint could not be reached; try again later.",
          attemptId: null, correlationKey: null, threadId: null,
        });
      }
      return launched({
        outcome: "blocked" as const, reason: "read_failed" as LaunchReason,
        detail: "T3 catalog could not be read.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }
    const advertised = catalogProviders.some(
      (provider) => provider.providerInstanceId === providerInstanceId && provider.models.some((entry) => entry.id === model),
    );
    if (!advertised) {
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: secret.connectionId, credentialVersion: secret.credentialVersion,
        at: Date.now(), errorCode: "model_unavailable",
      });
      return launched({
        outcome: "blocked" as const, reason: "model_unavailable" as LaunchReason,
        detail: "That model is not in the live T3 catalog; pick an advertised one.",
        attemptId: null, correlationKey: null, threadId: null,
      });
    }

    // 6. Reserve the durable attempt BEFORE the launch call. The same
    // attemptId with the same payload reuses the reservation; a different
    // payload or a competing id is refused without any remote launch. The
    // lock keys on the Linear issue id, so two different issues in the same
    // project and team never share a reservation.
    const branch = branchForAttempt(verifiedIssueIdentifier, args.attemptId);
    const payloadHash = canonicalPayloadHash({
      issueKey: linearIssueId,
      t3ProjectId: mapping.t3ProjectId,
      providerInstanceId, model, runtimeMode, prompt,
      baseRef: mapping.worktreeBaseRef,
      branch,
    });
    let prepared: { attemptId: string; correlationKey: string; state: string; reused: boolean; threadId: string | null };
    try {
      prepared = await ctx.runMutation(internal.launchAttempts.prepareLaunchAttempt, {
        issueKey: linearIssueId,
        issueIdentifier: verifiedIssueIdentifier,
        targetProjectId: mapping.t3ProjectId,
        attemptId: args.attemptId,
        payloadHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Same id with a different payload is a new launch riding an existing
      // reservation — never reuse it.
      if (message.includes("different payload") || message.includes("different target project")) {
        return throwLaunchInvalid(LAUNCH_PAYLOAD_MISMATCH);
      }
      // A competing id while an earlier attempt is unresolved, or a legacy row
      // without payload binding: the earlier attempt owns this issue until it
      // is reconciled or abandoned. No second launch may slip past it.
      return launched({
        outcome: "in_progress" as const, reason: null,
        detail: "This issue already has an unresolved launch attempt; reconcile or abandon it before launching again.",
        attemptId: args.attemptId, correlationKey: null, threadId: null,
      });
    }

    if (prepared.reused) {
      if ((prepared.state === "acknowledged" || prepared.state === "reconciled") && prepared.threadId) {
        return launched({
          outcome: "launched" as const, reason: null,
          detail: `This launch already completed as thread ${prepared.threadId}; no second launch was issued.`,
          attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: prepared.threadId,
        });
      }
      if (prepared.state === "dispatching") {
        return launched({
          outcome: "in_progress" as const, reason: null,
          detail: "This launch is already dispatching; no second launch was issued.",
          attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
        });
      }
      if (prepared.state === "ambiguous") {
        return launched({
          outcome: "ambiguous" as const, reason: "ambiguous" as LaunchReason,
          detail: "This launch ended ambiguous; reconcile it before launching again.",
          attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: prepared.threadId,
        });
      }
      if (prepared.state === "abandoned") {
        return throwLaunchInvalid(LAUNCH_ABANDONED_RETRY);
      }
      // state === "prepared": a previous invocation reserved but never
      // dispatched. Fall through to claim the dispatch below.
    }

    const dispatchClaimed: boolean = await ctx.runMutation(internal.launchAttempts.markDispatching, {
      attemptId: prepared.attemptId, at: Date.now(),
    });
    if (!dispatchClaimed) {
      return launched({
        outcome: "in_progress" as const, reason: null,
        detail: "Another invocation claimed this launch; no second launch was issued.",
        attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
      });
    }

    /**
     * Reconcile an unclear launch by searching T3 for this attempt's own
     * correlation key. Exactly one match resolves it; zero or many stay
     * ambiguous. This function NEVER relaunches.
     */
    const reconcile = async (): Promise<{
      state: string; matchCount: number; threadId: string | null; relaunchAuthorized: false;
    }> => {
      await assertOwnerCurrent();
      let matchCount = 0;
      let threadId: string | null = null;
      let searchFailed = true;
      try {
        const page: T3ReadPage = await ctx.runAction(api.t3OAuth.read, {
          connectionId: secret.connectionId,
          operation: "threads",
          input: { projectId: mapping.t3ProjectId, titleContains: prepared.correlationKey, limit: 100 },
        });
        if (Array.isArray(page.items)) {
          const hits = page.items.filter((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return false;
            const title = (item as Record<string, unknown>).title;
            const id = (item as Record<string, unknown>).threadId;
            return typeof title === "string" && title.includes(prepared.correlationKey) &&
              isValidT3ThreadId(id, secret.tokenCiphertext);
          });
          searchFailed = false;
          matchCount = hits.length;
          if (hits.length === 1) {
            threadId = (hits[0] as Record<string, unknown>).threadId as string;
          }
        }
      } catch {
        searchFailed = true;
      }
      await assertOwnerCurrent();
      // A failed search and a zero-match search are deliberately both
      // ambiguous: Helm cannot tell "did not happen" from "cannot see", and
      // both need a human.
      if (searchFailed) {
        const rec: { state: string; matchCount: number; threadId: string | null; relaunchAuthorized: false } =
          await ctx.runMutation(internal.launchAttempts.recordReconciliation, {
            attemptId: prepared.attemptId, matchCount: 0, threadId: null,
          });
        return rec;
      }
      const rec: { state: string; matchCount: number; threadId: string | null; relaunchAuthorized: false } =
        await ctx.runMutation(internal.launchAttempts.recordReconciliation, {
          attemptId: prepared.attemptId, matchCount, threadId,
        });
      return rec;
    };

    // 7. Launch exactly once through the write allowlist. The grant is
    // revalidated BEFORE the MCP transport is constructed — the bearer token
    // is transmitted during initialization — and again at the tool boundary.
    const title = `Helm ${linearProjectId}/${linearTeamId} ${prepared.correlationKey}`.slice(0, 200);
    const token = decryptStoredToken(secret.tokenCiphertext, { issuer: owner.issuer, subject: owner.subject }, secret.endpoint);
    await guards.beforeConnect();
    let launchResponse: Record<string, unknown>;
    try {
      launchResponse = await operateToolCall(secret.endpoint, token, secret.access, "t3_thread_launch", {
        projectId: mapping.t3ProjectId,
        title,
        modelSelection: { instanceId: providerInstanceId, model },
        runtimeMode,
        interactionMode: "default",
        message: prompt,
        workspaceStrategy: {
          type: "worktree",
          baseRef: mapping.worktreeBaseRef,
          branch,
          startFromOrigin: false,
        },
      }, guards.beforeCall);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // An owner-grant or credential race mid-flight is a fail-closed stop,
      // not a launch outcome: the guards throw before the tool call, so no
      // launch was issued and there is nothing to reconcile. Never pause
      // anything on this path, just stop.
      if (message.startsWith("unauthorized:") || message.includes("changed while the launch was in progress")) {
        throw error;
      }
      if (/T3 request failed \((401|403)\)/.test(message)) {
        await markReauthorizationRequired();
        const rec = await reconcile();
        return launched({
          outcome: "ambiguous" as const, reason: "ambiguous" as LaunchReason,
          detail: `T3 authorization was revoked during the launch; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`,
          attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
        });
      }
      const rec = await reconcile();
      return launched({
        outcome: "ambiguous" as const, reason: "ambiguous" as LaunchReason,
        detail: `The launch acknowledgement was unclear; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`,
        attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
      });
    }

    // 8. Acknowledge, or reconcile when the acknowledgement is incomplete.
    const returnedThreadId = nullableString(launchResponse.threadId);
    const returnedProjectId = nullableString(launchResponse.projectId);
    if (returnedProjectId !== null && returnedProjectId !== mapping.t3ProjectId) {
      const rec = await reconcile();
      return launched({
        outcome: "ambiguous" as const, reason: "ambiguous" as LaunchReason,
        detail: `T3 returned a different project than requested; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`,
        attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
      });
    }
    if (!isValidT3ThreadId(returnedThreadId, token)) {
      // The genuine lost acknowledgement: T3 may have accepted the launch but
      // the thread id never came back. Reconcile instead of relaunching.
      const rec = await reconcile();
      if (rec.state === "reconciled" && rec.threadId) {
        return launched({
          outcome: "launched" as const, reason: null,
          detail: "The launch was reconciled to its thread after an unclear acknowledgement; no second launch was issued.",
          attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous" as const, reason: "ambiguous" as LaunchReason,
        detail: `The launch was accepted but unresolved (matches=${rec.matchCount}). No relaunch was authorized.`,
        attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: null,
      });
    }
    await ctx.runMutation(internal.launchAttempts.markAcknowledged, {
      attemptId: prepared.attemptId, threadId: returnedThreadId, at: Date.now(),
    });
    return launched({
      outcome: "launched" as const, reason: null,
      detail: "T3 launch acknowledged.",
      attemptId: prepared.attemptId, correlationKey: prepared.correlationKey, threadId: returnedThreadId,
    });
  },
});
