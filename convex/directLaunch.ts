"use node";

import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isValidT3ThreadId } from "./lib/threadIdentity";
import { decryptStoredToken, operateToolCall } from "./t3OAuth";
import { deriveOutcomeForAttempt, type AttemptRecoveryOutcome } from "./lib/attemptRecovery";
import { classifyUnclaimedAttempt } from "./lib/directLaunchOutcome";
import {
  DIRECT_ABANDONED_RETRY,
  DIRECT_ATTEMPT_UNKNOWN,
  DIRECT_NAMESPACE_CHANGED,
  DIRECT_PAYLOAD_MISMATCH,
  DIRECT_REQUEST_INVALID,
  DIRECT_TARGET_MISMATCH,
} from "./lib/directLaunchErrors";
import { guardNativeWriteTarget } from "./lib/writeTargetPolicy";

/**
 * EGA-812 — owner-gated DIRECT project launch.
 *
 * This is the reusable server contract EGA-813 will call; it deliberately
 * contains no UI, no model-selection change and no worktree-strategy change.
 *
 * Order is deliberate and mirrors the proven issue-bound path:
 *   0. owner grant gate;
 *   1. shape validation (no database, no network);
 *   2. resolve the operate connection and its environment; fail closed;
 *   3. owner-approved native write target;
 *   4. verify the T3 project lives in that exact environment (read-only);
 *   5. verify the model is advertised by the LIVE catalogue;
 *   6. atomically reserve the intent (durable, before dispatch);
 *   7. claim dispatch and call `t3_thread_launch` exactly once, with the
 *      reserved native `clientRequestId`;
 *   8. acknowledge, or reconcile by the unique correlation marker.
 *
 * What it refuses to do:
 *   - dispatch on a changed credential namespace (reconnect / re-grant);
 *   - relaunch after a lost acknowledgement, zero matches or many matches;
 *   - infer "not sent" from a timeout or an error;
 *   - block unrelated intents in the same project.
 */

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const directReason = v.union(
  v.literal("authorization_required"),
  v.literal("expired"),
  v.literal("unreachable"),
  v.literal("rate_limited"),
  v.literal("model_unavailable"),
  v.literal("ambiguous"),
  v.literal("read_failed"),
  v.literal("credential_changed"),
);
type DirectReason = Infer<typeof directReason>;

const directLaunchReturns = v.object({
  outcome: v.union(
    v.literal("launched"),
    v.literal("blocked"),
    v.literal("in_progress"),
    v.literal("ambiguous"),
    v.literal("abandoned"),
  ),
  /** Null unless the outcome is `blocked` or `ambiguous`. */
  reason: v.union(directReason, v.null()),
  /** Fixed sanitized sentence; safe to render. */
  detail: v.string(),
  attemptId: v.union(v.string(), v.null()),
  correlationKey: v.union(v.string(), v.null()),
  threadId: v.union(v.string(), v.null()),
  /** Always false: this path never authorizes a relaunch. */
  relaunchAuthorized: v.literal(false),
});
type DirectLaunchResult = Infer<typeof directLaunchReturns>;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const WRITE_ENDPOINT_BASE_REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const OPAQUE_ID_PATTERN = /^[^\s\u0000-\u001f]{1,256}$/u;

const SETTLED: ReadonlySet<string> = new Set(["acknowledged", "reconciled"]);
const POSSIBLY_DISPATCHED: ReadonlySet<string> = new Set(["dispatching", "ambiguous"]);

/** Reconciliation bounds: pages, records and wall clock. */
const RECONCILE_PAGE_LIMIT = 100;
const RECONCILE_MAX_PAGES = 4;
const RECONCILE_MAX_RECORDS = 400;
const RECONCILE_DEADLINE_MS = 15_000;

type T3ReadPage = {
  items?: unknown;
  nextCursor?: unknown;
  environmentId?: unknown;
  projectId?: unknown;
};

function invalid(): never {
  throw new Error(DIRECT_REQUEST_INVALID);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid();
  return value;
}

function isBoundedOpaqueId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value);
}

/**
 * A base ref must be an explicit, well-formed ref. Anything ambiguous is
 * refused BEFORE a reservation, so a direct launch can never target an
 * unverified branch.
 */
function isAcceptableBaseRef(value: string): boolean {
  if (!WRITE_ENDPOINT_BASE_REF_PATTERN.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  return true;
}

/** Deterministic worktree branch per intent, so a retry reuses the same branch. */
function branchForIntent(attemptId: string): string {
  const suffix = createHash("sha256").update(`direct:${attemptId}`).digest("hex").slice(0, 8);
  return `helm/direct-${suffix}`;
}

/**
 * Canonical full-payload hash. Binds the intent id to the exact meaning of the
 * launch. The thread title and correlation marker are excluded because they are
 * minted at reservation time; the credential version and grant revision are
 * excluded on purpose so a reconnect is reported as a NAMESPACE change rather
 * than misdiagnosed as a payload change.
 */
function canonicalDirectPayloadHash(input: {
  attemptId: string;
  ownerSubject: string;
  ownerIssuer: string;
  connectionId: string;
  environmentId: string;
  projectId: string;
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
        "t3_direct_project_launch",
        "v1",
        input.attemptId,
        input.ownerSubject,
        input.ownerIssuer,
        input.connectionId,
        input.environmentId,
        input.projectId,
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

function launched(result: Omit<DirectLaunchResult, "relaunchAuthorized">): DirectLaunchResult {
  return { ...result, relaunchAuthorized: false as const };
}

function blocked(reason: DirectReason, detail: string): DirectLaunchResult {
  return launched({ outcome: "blocked", reason, detail, attemptId: null, correlationKey: null, threadId: null });
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Structural parse of the LIVE catalogue; malformed means "not verified". */
function parseCatalogProviders(value: unknown): { providerInstanceId: string; models: string[] }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("T3 catalog could not be read");
  const providers = (value as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) throw new Error("T3 catalog could not be read");
  return providers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("T3 catalog could not be read");
    const provider = entry as Record<string, unknown>;
    if (typeof provider.providerInstanceId !== "string" || !Array.isArray(provider.models)) {
      throw new Error("T3 catalog could not be read");
    }
    const models = (provider.models as unknown[]).map((modelEntry) => {
      if (!modelEntry || typeof modelEntry !== "object" || Array.isArray(modelEntry)) {
        throw new Error("T3 catalog could not be read");
      }
      const id = (modelEntry as Record<string, unknown>).id;
      if (typeof id !== "string") throw new Error("T3 catalog could not be read");
      return id;
    });
    return { providerInstanceId: provider.providerInstanceId, models };
  });
}

type ReconcileTarget = {
  attemptId: string;
  connectionId: Id<"t3Connections">;
  credentialVersion: number;
  environmentId: string;
  projectId: string;
  correlationKey: string;
};

type ReconcileOutcome = {
  state: string;
  matchCount: number;
  threadId: string | null;
  safeToProceed: boolean;
  /**
   * False when the bounded search never completed (unreadable connection,
   * changed namespace, error, or a bound was hit). A false value means
   * `matchCount` is NOT evidence of "zero matches".
   */
  searched: boolean;
};

/**
 * Bounded, read-only reconciliation against the ORIGINAL connection,
 * environment and project.
 *
 * It refuses to interpret evidence gathered under a changed credential
 * namespace or a different environment, rejects cross-project and
 * cross-environment rows even when a title collides, and stops at fixed page,
 * record and time bounds. One unique match settles; everything else is
 * ambiguous and nothing is ever re-dispatched.
 */
async function reconcileDirectAttempt(
  ctx: ActionCtx,
  owner: Owner,
  target: ReconcileTarget,
  guard: () => Promise<unknown>,
): Promise<ReconcileOutcome> {
  await guard();

  const record = async (
    matchCount: number,
    threadId: string | null,
    note: string,
    searched: boolean,
  ): Promise<ReconcileOutcome> => {
    const rec: {
      state: string;
      safeToProceed: boolean;
      relaunchAuthorized: false;
      matchCount: number;
      threadId: string | null;
      note: string | null;
    } = await ctx.runMutation(internal.directLaunchAttempts.recordDirectReconciliation, {
      ownerSubject: owner.subject,
      ownerIssuer: owner.issuer,
      attemptId: target.attemptId,
      matchCount,
      threadId,
      note,
    });
    return {
      state: rec.state,
      matchCount: rec.matchCount,
      threadId: rec.threadId,
      safeToProceed: rec.safeToProceed,
      searched,
    };
  };

  let secret: {
    connectionId: Id<"t3Connections">;
    environmentId: string;
    credentialVersion: number;
    access: string;
    status: string;
    tokenCiphertext: string;
  } | null = null;
  try {
    secret = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
      ...storeOwner(owner),
      connectionId: target.connectionId,
      now: Date.now(),
    });
  } catch {
    secret = null;
  }
  if (!secret || secret.access !== "operate" || secret.status !== "connected") {
    return await record(0, null, "reconciliation could not read the original T3 operate connection", false);
  }
  if (secret.connectionId !== target.connectionId || secret.environmentId !== target.environmentId) {
    return await record(0, null, "reconciliation refused: the original T3 environment is no longer reachable", false);
  }
  if (secret.credentialVersion !== target.credentialVersion) {
    // The native retry key is only idempotent inside one credential namespace.
    // A read under a new namespace cannot be presented as proof for the old
    // one, and nothing may be re-sent.
    return await record(0, null, "reconciliation refused: the T3 credential namespace changed", false);
  }

  const seen = new Set<string>();
  let complete = false;
  let records = 0;
  let pages = 0;
  let cursor: number | undefined;
  const deadline = Date.now() + RECONCILE_DEADLINE_MS;

  try {
    while (pages < RECONCILE_MAX_PAGES && records < RECONCILE_MAX_RECORDS && Date.now() < deadline) {
      const page = (await ctx.runAction(api.t3OAuth.read, {
        connectionId: target.connectionId,
        operation: "threads",
        input: {
          projectId: target.projectId,
          titleContains: target.correlationKey,
          limit: RECONCILE_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      })) as unknown as T3ReadPage;
      pages++;
      if (!Array.isArray(page.items)) break;
      for (const item of page.items) {
        records++;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        // A title collision in another project or environment is never evidence
        // for this attempt.
        if (row.projectId !== target.projectId) continue;
        if (row.environmentId !== target.environmentId) continue;
        const title = row.title;
        if (typeof title !== "string" || !title.includes(target.correlationKey)) continue;
        if (!isValidT3ThreadId(row.threadId, secret.tokenCiphertext)) continue;
        seen.add(row.threadId);
      }
      const next = page.nextCursor;
      if (next === null || next === undefined) {
        complete = true;
        break;
      }
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) break;
      cursor = next;
    }
  } catch {
    complete = false;
  }

  await guard();

  if (!complete) {
    return await record(
      seen.size === 1 ? 0 : seen.size,
      null,
      "reconciliation is incomplete within its bounds; no relaunch was authorized",
      false,
    );
  }
  if (seen.size === 1) {
    const [threadId] = [...seen];
    return await record(1, threadId!, "one exact correlation match settled the attempt", true);
  }
  return await record(
    seen.size,
    null,
    seen.size === 0
      ? "reconciliation found no matching thread; no relaunch was authorized"
      : `reconciliation found ${seen.size} matching threads; no relaunch was authorized`,
    true,
  );
}

type DirectLaunchArgs = {
  intentId: string;
  connectionId: Id<"t3Connections">;
  environmentId: string;
  projectId: string;
  prompt: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  baseRef: string;
};

/**
 * Owner-gated direct project launch. The caller supplies a stable `intentId`
 * for one logical launch; retries of that launch must reuse it.
 */
export const launchDirect = action({
  args: {
    intentId: v.string(),
    connectionId: v.id("t3Connections"),
    environmentId: v.string(),
    projectId: v.string(),
    prompt: v.string(),
    providerInstanceId: v.string(),
    model: v.string(),
    runtimeMode: v.string(),
    baseRef: v.string(),
  },
  returns: directLaunchReturns,
  handler: async (ctx: ActionCtx, args: DirectLaunchArgs): Promise<DirectLaunchResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });

    // 1. Shape checks fail before any database or network access.
    if (!ATTEMPT_ID_PATTERN.test(args.intentId)) invalid();
    const environmentId = boundedText(args.environmentId, 256);
    const projectId = boundedText(args.projectId, 256);
    if (!isBoundedOpaqueId(environmentId) || !isBoundedOpaqueId(projectId)) invalid();
    const prompt = boundedText(args.prompt, 30000);
    const providerInstanceId = boundedText(args.providerInstanceId, 256);
    const model = boundedText(args.model, 256);
    const runtimeMode = boundedText(args.runtimeMode, 64);
    const baseRef = boundedText(args.baseRef, 200);
    if (!isAcceptableBaseRef(baseRef)) invalid();
    await assertOwnerCurrent();

    // 2. The operate connection must exist, be usable and be the one the
    // caller names. No "current connection" fallback: the environment is an
    // explicit part of the target.
    const secret: {
      connectionId: Id<"t3Connections">;
      endpoint: string;
      environmentId: string;
      credentialVersion: number;
      access: string;
      status: string;
      tokenCiphertext: string;
    } | null = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
      ...storeOwner(owner),
      connectionId: args.connectionId,
      now: Date.now(),
    });
    if (!secret) {
      return blocked("authorization_required", "T3 operate access is unavailable; complete the operate consent first.");
    }
    if (secret.access !== "operate") {
      return blocked("authorization_required", "T3 operate access has not been granted; complete the operate consent first.");
    }
    if (secret.environmentId !== environmentId) {
      return blocked(
        "authorization_required",
        "The requested T3 environment does not match the operate connection; no launch was sent.",
      );
    }
    if (secret.status === "expired") {
      return blocked("expired", "T3 connection has expired; reconnect it to continue.");
    }
    if (secret.status === "reauthorizationRequired") {
      return blocked("authorization_required", "T3 authorization was revoked; reconnect to continue.");
    }
    if (secret.status === "unreachable") {
      return blocked("unreachable", "T3 connection is unreachable; refresh it before launching.");
    }
    if (secret.status !== "connected") {
      return blocked("read_failed", "T3 operate connection is not usable; reconnect it to continue.");
    }

    // 3. Owner-approved native write target. Fail-closed by default.
    const writeTarget = guardNativeWriteTarget({
      endpoint: secret.endpoint,
      environmentId: secret.environmentId,
    });
    if (!writeTarget.ok) return blocked("authorization_required", writeTarget.detail);

    const assertConnectionCurrent = (): Promise<boolean> =>
      ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, {
        ...storeOwner(owner),
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
      });
    const markReauthorizationRequired = (): Promise<null> =>
      ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner),
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
        at: Date.now(),
        status: "reauthorizationRequired",
        errorCode: "authorization_required",
      });

    const classifyReadFailure = async (error: unknown): Promise<DirectLaunchResult> => {
      const message = error instanceof Error ? error.message : "";
      if (/T3 request failed \((401|403)\)/u.test(message)) {
        await markReauthorizationRequired();
        return blocked("authorization_required", "T3 authorization was revoked; reconnect to continue.");
      }
      if (/T3 request failed \(429\)/u.test(message)) return blocked("rate_limited", "T3 is receiving too many requests; try again shortly.");
      if (/could not be reached|timed out|T3 request failed \(5\d\d\)/iu.test(message)) {
        return blocked("unreachable", "The T3 endpoint could not be reached; try again later.");
      }
      return blocked("read_failed", "The T3 target could not be verified; no launch was sent.");
    };

    // 4. The project must exist in this exact environment. The read adapter
    // itself rejects a page from another project and re-verifies the
    // environment identity, so this is verification, not trust.
    await assertOwnerCurrent();
    let projectView: { projectId?: unknown; environmentId?: unknown; connectionId?: unknown };
    try {
      projectView = (await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "project",
        input: { projectId },
      })) as unknown as { projectId?: unknown; environmentId?: unknown; connectionId?: unknown };
    } catch (error) {
      return await classifyReadFailure(error);
    }
    if (
      projectView.projectId !== projectId ||
      projectView.environmentId !== environmentId ||
      String(projectView.connectionId ?? "") !== String(secret.connectionId)
    ) {
      return blocked("read_failed", "The T3 project does not belong to this environment; no launch was sent.");
    }

    // 5. The model must be advertised by the LIVE catalogue.
    await assertOwnerCurrent();
    let providers: { providerInstanceId: string; models: string[] }[];
    try {
      const capabilities = await ctx.runAction(api.t3OAuth.read, {
        connectionId: secret.connectionId,
        operation: "capabilities",
        input: {},
      });
      providers = parseCatalogProviders(capabilities);
    } catch (error) {
      return await classifyReadFailure(error);
    }
    const advertised = providers.some(
      (provider) =>
        provider.providerInstanceId === providerInstanceId && provider.models.includes(model),
    );
    if (!advertised) {
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner),
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
        at: Date.now(),
        errorCode: "model_unavailable",
      });
      return blocked("model_unavailable", "That model is not in the live T3 catalog; pick an advertised one.");
    }

    // 6. Reserve the intent BEFORE any dispatch. The row is the idempotency
    // authority from here on: a concurrent tab or a double click presents the
    // same intent and observes it.
    const branch = branchForIntent(args.intentId);
    const payloadHash = canonicalDirectPayloadHash({
      attemptId: args.intentId,
      ownerSubject: owner.subject,
      ownerIssuer: owner.issuer,
      connectionId: String(secret.connectionId),
      environmentId,
      projectId,
      providerInstanceId,
      model,
      runtimeMode,
      prompt,
      baseRef,
      branch,
    });

    let reserved: {
      attemptId: string;
      correlationKey: string;
      clientRequestId: string;
      state: string;
      reused: boolean;
      threadId: string | null;
      connectionId: Id<"t3Connections">;
      credentialVersion: number;
      environmentId: string;
      projectId: string;
      ownerRevision: number;
      namespaceChanged: boolean;
    };
    try {
      reserved = await ctx.runMutation(internal.directLaunchAttempts.reserveDirectLaunch, {
        ownerSubject: owner.subject,
        ownerIssuer: owner.issuer,
        ownerRevision: owner.revision,
        connectionId: secret.connectionId,
        credentialVersion: secret.credentialVersion,
        environmentId,
        projectId,
        attemptId: args.intentId,
        payloadHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === DIRECT_PAYLOAD_MISMATCH || message === DIRECT_TARGET_MISMATCH) {
        // Shape refusal, never a dispatch. Thrown like the issue-bound path so
        // a future route can map it to invalid_request.
        throw new Error(message);
      }
      throw error;
    }

    if (reserved.reused) {
      if (SETTLED.has(reserved.state) && reserved.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: `This intent already completed as thread ${reserved.threadId}; no second launch was issued.`,
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: reserved.threadId,
        });
      }
      if (reserved.state === "abandoned") throw new Error(DIRECT_ABANDONED_RETRY);
      if (reserved.namespaceChanged) {
        if (POSSIBLY_DISPATCHED.has(reserved.state)) {
          return launched({
            outcome: "ambiguous",
            reason: "credential_changed" as DirectReason,
            detail:
              "The T3 connection changed after this intent may have been dispatched. It was not re-sent; reconcile the original intent.",
            attemptId: reserved.attemptId,
            correlationKey: reserved.correlationKey,
            threadId: null,
          });
        }
        return launched({
          outcome: "blocked",
          reason: "credential_changed" as DirectReason,
          detail: DIRECT_NAMESPACE_CHANGED,
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      if (reserved.state === "dispatching") {
        return launched({
          outcome: "in_progress",
          reason: null,
          detail: "This intent is already dispatching; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      if (reserved.state === "ambiguous") {
        return launched({
          outcome: "ambiguous",
          reason: "ambiguous" as DirectReason,
          detail: "This intent ended ambiguous; reconcile it before starting another launch of the same intent.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      // state === "prepared": reserved but provably never dispatched.
    }

    // 7. Local-only work and the pre-connect guard run BEFORE the
    // irreversible claim, so a corrupt token or an already-changed grant
    // cannot leave the intent stuck in `dispatching` without a call.
    const token = decryptStoredToken(secret.tokenCiphertext, { issuer: owner.issuer, subject: owner.subject }, secret.endpoint);
    await assertOwnerCurrent();
    if (!(await assertConnectionCurrent())) {
      throw new Error("T3 connection changed while the launch was in progress");
    }

    // 8. Claim the ONE irreversible dispatch transition before the call.
    let claimed: boolean;
    try {
      claimed = await ctx.runMutation(internal.directLaunchAttempts.markDirectDispatching, {
        ownerSubject: owner.subject,
        ownerIssuer: owner.issuer,
        attemptId: reserved.attemptId,
        credentialVersion: secret.credentialVersion,
        ownerRevision: owner.revision,
        at: Date.now(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === DIRECT_NAMESPACE_CHANGED) {
        return launched({
          outcome: "blocked",
          reason: "credential_changed" as DirectReason,
          detail: DIRECT_NAMESPACE_CHANGED,
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      throw error;
    }
    if (!claimed) {
      // Another invocation claimed the dispatch between our reservation read
      // and this claim. Report the DURABLE result it reached, not a blanket
      // "in progress": it may already have settled this intent.
      const current = await ctx.runQuery(internal.directLaunchAttempts.getDirectAttempt, {
        ownerSubject: owner.subject,
        ownerIssuer: owner.issuer,
        attemptId: reserved.attemptId,
      });
      const unclaimed = classifyUnclaimedAttempt(current);
      if (unclaimed.kind === "settled") {
        return launched({
          outcome: "launched",
          reason: null,
          detail: `This intent already completed as thread ${unclaimed.threadId}; no second launch was issued.`,
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: unclaimed.threadId,
        });
      }
      if (unclaimed.kind === "ambiguous") {
        return launched({
          outcome: "ambiguous",
          reason: "ambiguous" as DirectReason,
          detail: "This intent ended ambiguous; reconcile it before starting another launch of the same intent.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      if (unclaimed.kind === "abandoned") throw new Error(DIRECT_ABANDONED_RETRY);
      return launched({
        outcome: "in_progress",
        reason: null,
        detail: "Another invocation claimed this intent; no second launch was issued.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }

    const target: ReconcileTarget = {
      attemptId: reserved.attemptId,
      connectionId: reserved.connectionId,
      credentialVersion: secret.credentialVersion,
      environmentId,
      projectId,
      correlationKey: reserved.correlationKey,
    };

    // The ledger state is re-checked at the tool boundary: an operator
    // abandonment that landed after the dispatch claim cancels the send.
    const guards = {
      beforeConnect: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the launch was in progress");
      },
      beforeCall: async (): Promise<void> => {
        await assertOwnerCurrent();
        if (!(await assertConnectionCurrent())) throw new Error("T3 connection changed while the launch was in progress");
        const current = await ctx.runQuery(internal.directLaunchAttempts.getDirectAttempt, {
          ownerSubject: owner.subject,
          ownerIssuer: owner.issuer,
          attemptId: reserved.attemptId,
        });
        if (!current || current.state !== "dispatching") {
          throw new Error("direct launch attempt changed before dispatch");
        }
      },
    };

    // 9. Dispatch exactly once. The grant and connection are revalidated
    // before the transport exists and again at the tool boundary.
    // Marker FIRST: the correlation key is the only reconciliation
    // discriminator, so a very long project id must never truncate it away.
    const title = `${reserved.correlationKey} Helm direct ${projectId}`.slice(0, 200);
    await guards.beforeConnect();
    let response: Record<string, unknown>;
    try {
      response = await operateToolCall(
        secret.endpoint,
        token,
        secret.access,
        "t3_thread_launch",
        {
          projectId,
          title,
          modelSelection: { instanceId: providerInstanceId, model },
          runtimeMode,
          interactionMode: "default",
          message: prompt,
          workspaceStrategy: {
            type: "worktree",
            baseRef,
            branch,
            startFromOrigin: false,
          },
          clientRequestId: reserved.clientRequestId,
        },
        guards.beforeCall,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // A guard race is a fail-closed stop BEFORE the call: nothing was sent,
      // so it is not a launch outcome.
      if (
        message.startsWith("unauthorized:") ||
        message.includes("changed while the launch was in progress") ||
        message.includes("changed before dispatch")
      ) {
        throw error;
      }
      if (/T3 request failed \((401|403)\)/u.test(message)) {
        try {
          await markReauthorizationRequired();
        } catch {
          // The pause marker is best-effort; the ambiguity below is the
          // durable truth either way.
        }
      }
      const rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
      if (rec.safeToProceed && rec.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: "The launch was reconciled to its thread after an unclear acknowledgement; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous",
        reason: "ambiguous" as DirectReason,
        detail: rec.searched
          ? `The launch acknowledgement was unclear; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`
          : "The launch acknowledgement was unclear and the bounded reconciliation could not complete. No relaunch was authorized.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }

    const returnedProjectId = nullableString(response.projectId);
    const returnedThreadId = nullableString(response.threadId);
    if (returnedProjectId === null) {
      // The ack did not prove its target. Do not acknowledge on an unproven
      // thread: settle only through the unique marker scoped to the original
      // project/environment/connection.
      const rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
      if (rec.safeToProceed && rec.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: "The launch was reconciled to its thread after an unproven acknowledgement; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous",
        reason: "ambiguous" as DirectReason,
        detail: rec.searched
          ? `The launch acknowledgement did not prove its project; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`
          : "The launch acknowledgement did not prove its project and the bounded reconciliation could not complete. No relaunch was authorized.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }
    if (returnedProjectId !== projectId) {
      const rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
      if (rec.safeToProceed && rec.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: "The launch was reconciled to its thread despite a conflicting project in the acknowledgement; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous",
        reason: "ambiguous" as DirectReason,
        detail: rec.searched
          ? `T3 returned a different project than requested; reconciliation found ${rec.matchCount} matching threads. No relaunch was authorized.`
          : "T3 returned a different project than requested and the bounded reconciliation could not complete. No relaunch was authorized.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }
    if (!isValidT3ThreadId(returnedThreadId, token)) {
      // The genuine lost acknowledgement: T3 may have accepted the launch but
      // the thread id never came back. Reconcile instead of relaunching.
      const rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
      if (rec.safeToProceed && rec.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: "The launch was accepted and reconciled to its thread; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous",
        reason: "ambiguous" as DirectReason,
        detail: rec.searched
          ? `The launch was accepted but unresolved (matches=${rec.matchCount}). No relaunch was authorized.`
          : "The launch was accepted but the bounded reconciliation could not complete. No relaunch was authorized.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }

    try {
      await ctx.runMutation(internal.directLaunchAttempts.markDirectAcknowledged, {
        ownerSubject: owner.subject,
        ownerIssuer: owner.issuer,
        attemptId: reserved.attemptId,
        threadId: returnedThreadId,
        at: Date.now(),
      });
    } catch {
      // The remote launch succeeded but the ledger refused the acknowledgement
      // (for example, a conflicting settled thread). Keep the durable truth
      // ambiguous rather than claiming success. Reconstruction must never
      // throw out of this handler.
      let rec: ReconcileOutcome;
      try {
        rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
      } catch {
        return launched({
          outcome: "ambiguous",
          reason: "ambiguous" as DirectReason,
          detail: "The launch acknowledgement could not be recorded; reconcile the original intent. No relaunch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: null,
        });
      }
      if (rec.safeToProceed && rec.threadId) {
        return launched({
          outcome: "launched",
          reason: null,
          detail: "The launch was reconciled to its thread; no second launch was issued.",
          attemptId: reserved.attemptId,
          correlationKey: reserved.correlationKey,
          threadId: rec.threadId,
        });
      }
      return launched({
        outcome: "ambiguous",
        reason: "ambiguous" as DirectReason,
        detail: "The launch acknowledgement could not be recorded; reconcile the original intent. No relaunch was issued.",
        attemptId: reserved.attemptId,
        correlationKey: reserved.correlationKey,
        threadId: null,
      });
    }

    return launched({
      outcome: "launched",
      reason: null,
      detail: "T3 direct launch acknowledged.",
      attemptId: reserved.attemptId,
      correlationKey: reserved.correlationKey,
      threadId: returnedThreadId,
    });
  },
});

const directAttemptRecoveryReturns = v.union(
  v.null(),
  v.object({
    attemptId: v.string(),
    correlationKey: v.string(),
    state: v.string(),
    threadId: v.union(v.string(), v.null()),
    connectionId: v.id("t3Connections"),
    environmentId: v.string(),
    projectId: v.string(),
    dispatchedAt: v.union(v.number(), v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
    matchCount: v.union(v.number(), v.null()),
    note: v.union(v.string(), v.null()),
  }),
);

const recoverDirectReturns = v.object({
  latest: directAttemptRecoveryReturns,
  outcome: v.union(
    v.literal("none"),
    v.literal("unresolved"),
    v.literal("acknowledged"),
    v.literal("ambiguous"),
    v.literal("abandoned"),
  ),
});

/**
 * Owner-gated, read-only reload. Convex is the source of truth: the same
 * intent returns the SAME durable attempt and state after a refresh, and the
 * caller never has to trust browser memory.
 *
 * `intentId` selects one intent; without it the newest attempt for the
 * (owner, project) pair is returned. No mutation, no network, no relaunch.
 */
export const recoverDirect = action({
  args: {
    projectId: v.string(),
    /** A project id is only unique inside one environment. */
    environmentId: v.string(),
    /** Optional connection scope for a reload of one specific grant. */
    connectionId: v.optional(v.id("t3Connections")),
    intentId: v.optional(v.string()),
  },
  returns: recoverDirectReturns,
  handler: async (ctx: ActionCtx, args): Promise<{
    latest: {
      attemptId: string;
      correlationKey: string;
      state: string;
      threadId: string | null;
      connectionId: Id<"t3Connections">;
      environmentId: string;
      projectId: string;
      dispatchedAt: number | null;
      acknowledgedAt: number | null;
      matchCount: number | null;
      note: string | null;
    } | null;
    outcome: AttemptRecoveryOutcome;
  }> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });
    const projectId = boundedText(args.projectId, 256);
    const environmentId = boundedText(args.environmentId, 256);
    if (!isBoundedOpaqueId(projectId) || !isBoundedOpaqueId(environmentId)) invalid();
    if (args.intentId !== undefined && !ATTEMPT_ID_PATTERN.test(args.intentId)) invalid();
    await assertOwnerCurrent();

    const row = args.intentId
      ? await ctx.runQuery(internal.directLaunchAttempts.getDirectAttempt, {
          ownerSubject: owner.subject,
          ownerIssuer: owner.issuer,
          attemptId: args.intentId,
        })
      : await ctx.runQuery(internal.directLaunchAttempts.latestDirectAttemptForProject, {
          ownerSubject: owner.subject,
          ownerIssuer: owner.issuer,
          environmentId,
          projectId,
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        });
    await assertOwnerCurrent();
    if (
      !row ||
      row.projectId !== projectId ||
      row.environmentId !== environmentId ||
      (args.connectionId !== undefined && row.connectionId !== args.connectionId)
    ) {
      return { latest: null, outcome: "none" as const };
    }
    return {
      latest: {
        attemptId: row.attemptId,
        correlationKey: row.correlationKey,
        state: row.state,
        threadId: row.threadId,
        connectionId: row.connectionId,
        environmentId: row.environmentId,
        projectId: row.projectId,
        dispatchedAt: row.dispatchedAt,
        acknowledgedAt: row.acknowledgedAt,
        matchCount: row.matchCount,
        note: row.note,
      },
      outcome: deriveOutcomeForAttempt(row.state),
    };
  },
});

/**
 * Owner-gated, explicit recovery of a possibly-sent direct launch.
 *
 * Read-only against T3 and bounded: one unique correlation match settles the
 * original attempt; zero, many, a changed credential namespace or an
 * incomplete bounded search stay ambiguous. It NEVER launches and never
 * authorizes a relaunch.
 */
export const reconcileDirect = action({
  args: { intentId: v.string() },
  returns: directLaunchReturns,
  handler: async (ctx: ActionCtx, args): Promise<DirectLaunchResult> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });
    if (!ATTEMPT_ID_PATTERN.test(args.intentId)) invalid();
    await assertOwnerCurrent();

    const row = await ctx.runQuery(internal.directLaunchAttempts.getDirectAttempt, {
      ownerSubject: owner.subject,
      ownerIssuer: owner.issuer,
      attemptId: args.intentId,
    });
    if (!row) throw new Error(DIRECT_ATTEMPT_UNKNOWN);

    if (SETTLED.has(row.state) && row.threadId) {
      return launched({
        outcome: "launched",
        reason: null,
        detail: `This intent already completed as thread ${row.threadId}; no launch was issued.`,
        attemptId: row.attemptId,
        correlationKey: row.correlationKey,
        threadId: row.threadId,
      });
    }
    if (row.state === "prepared") {
      // Provably never dispatched: the irreversible transition is persisted
      // before the call, so a prepared row needs no reconciliation and must not
      // be reported as possibly sent.
      return launched({
        outcome: "in_progress",
        reason: null,
        detail: "This intent is reserved but was never dispatched; no reconciliation was needed and no launch was issued.",
        attemptId: row.attemptId,
        correlationKey: row.correlationKey,
        threadId: null,
      });
    }

    const target: ReconcileTarget = {
      attemptId: row.attemptId,
      connectionId: row.connectionId,
      credentialVersion: row.credentialVersion,
      environmentId: row.environmentId,
      projectId: row.projectId,
      correlationKey: row.correlationKey,
    };
    const rec = await reconcileDirectAttempt(ctx, owner, target, assertOwnerCurrent);
    if (rec.safeToProceed && rec.threadId) {
      return launched({
        outcome: "launched",
        reason: null,
        detail: "One exact correlation match settled the original attempt; no launch was issued.",
        attemptId: row.attemptId,
        correlationKey: row.correlationKey,
        threadId: rec.threadId,
      });
    }
    if (row.state === "abandoned") {
      // Positive evidence always wins, but a zero/many observation must not
      // discard the operator's explicit decision.
      return launched({
        outcome: "abandoned",
        reason: null,
        detail: "This intent was abandoned and no exact correlation match was found. No relaunch was authorized.",
        attemptId: row.attemptId,
        correlationKey: row.correlationKey,
        threadId: null,
      });
    }
    return launched({
      outcome: "ambiguous",
      reason: "ambiguous" as DirectReason,
      detail: rec.searched
        ? `Reconciliation found ${rec.matchCount} matching threads and did not settle the attempt. No relaunch was authorized.`
        : "The bounded reconciliation could not complete; the attempt stays unresolved and no relaunch was authorized.",
      attemptId: row.attemptId,
      correlationKey: row.correlationKey,
      threadId: null,
    });
  },
});

const abandonDirectReturns = v.object({
  attemptId: v.string(),
  state: v.string(),
  /** True only when this call moved the intent to `abandoned`. */
  abandoned: v.boolean(),
});

/**
 * Owner-gated, explicit abandonment of an unresolved or ambiguous intent.
 *
 * This is the operator exit for an attempt that can never be reconciled (for
 * example a crash between the dispatch claim and the transport, or a changed
 * credential namespace). It never launches, never touches T3 and never
 * discards a settled attempt: a confirmed thread stays confirmed.
 */
export const abandonDirect = action({
  args: { intentId: v.string(), note: v.optional(v.string()) },
  returns: abandonDirectReturns,
  handler: async (ctx: ActionCtx, args): Promise<{
    attemptId: string;
    state: string;
    abandoned: boolean;
  }> => {
    const owner: Owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = (): Promise<true> =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });
    if (!ATTEMPT_ID_PATTERN.test(args.intentId)) invalid();
    const note = args.note === undefined ? undefined : boundedText(args.note, 500);
    await assertOwnerCurrent();

    const row = await ctx.runQuery(internal.directLaunchAttempts.getDirectAttempt, {
      ownerSubject: owner.subject,
      ownerIssuer: owner.issuer,
      attemptId: args.intentId,
    });
    if (!row) throw new Error(DIRECT_ATTEMPT_UNKNOWN);
    if (SETTLED.has(row.state)) {
      throw new Error(
        "This intent already completed; a confirmed launch cannot be abandoned or discarded.",
      );
    }
    if (row.state === "abandoned") {
      return { attemptId: row.attemptId, state: row.state, abandoned: false };
    }

    await ctx.runMutation(internal.directLaunchAttempts.abandonDirectAttempt, {
      ownerSubject: owner.subject,
      ownerIssuer: owner.issuer,
      attemptId: args.intentId,
      ...(note === undefined ? {} : { note }),
    });
    await assertOwnerCurrent();
    return { attemptId: args.intentId, state: "abandoned", abandoned: true };
  },
});
