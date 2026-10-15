"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  isolatedConfigDetail,
  resolveIsolatedProjectBinding,
  resolveIsolatedDispatchConfig,
} from "./lib/dispatchConfig";
import { isValidT3ThreadId } from "./lib/threadIdentity";

/**
 * Helm dispatch (EGA-677 task 4).
 *
 * Wires the two previously-unwired records into a real dispatch path:
 *   - `credentials` gates dispatch and pauses on any auth failure;
 *   - `launchAttempts` persists a UNIQUE correlation key BEFORE dispatch, and
 *     reconciles a lost acknowledgment without ever auto-relaunching.
 *
 * This runs against the ISOLATED instance by default. It never pushes: the target
 * workspace has no real remote, and this action only ever calls launch/read/
 * interrupt MCP tools.
 *
 * Isolation is EXCLUSIVE. The endpoint and the bearer token come only from
 * `T3_MCP_URL_ISOLATED` / `T3_MCP_TOKEN_ISOLATED` (see
 * `convex/lib/dispatchConfig.ts`), and a deployment that has not configured both
 * is refused before any MCP call is made. There is no `?? process.env.T3_MCP_URL`
 * fallback anywhere in this file: falling back to the privileged instance's
 * credentials is precisely the failure mode this hardening removes.
 *
 * Durable idempotency (M-2): the caller presents a stable request identifier,
 * and the attempt row is reserved BEFORE dispatch under that id, bound to the
 * hash of the canonical payload. A retry with the same id and payload reuses
 * the existing attempt and never issues a second remote launch; the same id
 * with a different payload is rejected; and a competing id is refused while an
 * earlier attempt for the issue is unresolved.
 */

const PROVIDER = "opencode_2";
const MODEL = "opencode/step-5-preview-free";

/**
 * The ONLY credential provider bound to the isolated T3 dispatch target
 * (EGA-677 binding rule). Dispatch refuses any other value instead of silently
 * selecting a different credential for the configured target. (The exact
 * project-mapping integration remains with EGA-679; until then the projectId is
 * carried verbatim, bound into the canonical payload hash, and never
 * substituted.)
 */
const T3_MCP_PROVIDER = "t3-mcp";
const REQUIRED_RUNTIME_MODE = "approval-required" as const;

/**
 * Canonical payload hash for a dispatch request (M-2).
 *
 * Binds the request identifier to the exact meaning of the launch: provider,
 * issue, project, message and runtime mode. An invocation presenting the same
 * request id with a different canonical payload is refused by the reservation,
 * never silently reused.
 */
async function canonicalPayloadHash(input: {
  provider: string;
  issueKey: string;
  projectId: string;
  message: string;
  runtimeMode: string;
}): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.provider,
        input.issueKey,
        input.projectId,
        input.message,
        input.runtimeMode,
      ]),
    )
    .digest("hex");
}

/**
 * Search T3 for threads belonging to one launch attempt.
 *
 * Matching is on the correlation key embedded in the thread title, not a fuzzy
 * issue number: an issue can legitimately have several threads over time, and a
 * loose match would let Helm "reconcile" onto somebody else's thread.
 */
async function findThreadsForCorrelation(
  endpoint: string,
  token: string,
  correlationKey: string,
  projectId: string,
  guards?: McpGuards,
): Promise<{ matchCount: number; threadId: string | null; searchFailed: boolean }> {
  const res = await callTool(endpoint, token, "t3_thread_list", { projectId, limit: 100 }, guards);
  if (!res.ok) return { matchCount: 0, threadId: null, searchFailed: true };
  try {
    const parsed = JSON.parse(res.text) as { threads?: unknown };
    if (!Array.isArray(parsed.threads)) return { matchCount: 0, threadId: null, searchFailed: true };
    const hits = (parsed.threads as Array<{ threadId?: unknown; title?: unknown }>).filter(
      (t) => typeof t?.title === "string" && t.title.includes(correlationKey),
    );
    if (hits.length === 1) {
      const threadId = hits[0]!.threadId;
      if (!isValidT3ThreadId(threadId, token)) {
        return { matchCount: 0, threadId: null, searchFailed: true };
      }
      return { matchCount: 1, threadId, searchFailed: false };
    }
    return { matchCount: hits.length, threadId: null, searchFailed: false };
  } catch {
    // Could not read the listing: we do not know if the launch happened.
    return { matchCount: 0, threadId: null, searchFailed: true };
  }
}

/** Normalize an MCP failure into a dispatch decision. */
export type DispatchOutcome =
  | { kind: "dispatched"; threadId: string; runId: string | null }
  | { kind: "paused"; reason: string }
  | { kind: "ambiguous"; detail: string };

/**
 * Authorization checkpoints around one remote MCP exchange (L-1).
 *
 * `beforeConnect` runs BEFORE the transport is constructed and connected: the
 * bearer token is transmitted during MCP initialization, so revalidating the
 * owner grant only after `connect()` would send the credential of a possibly
 * revoked grant. `beforeCall` re-rechecks immediately before the tool call
 * itself, the last boundary before a remote operation.
 *
 * Both are optional so pure transports (none exist today outside tests) can
 * omit them, but every dispatch path passes both.
 */
export interface McpGuards {
  beforeConnect?: () => Promise<void>;
  beforeCall?: () => Promise<void>;
}

export async function callTool(
  endpoint: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  guards?: McpGuards,
): Promise<{ ok: boolean; text: string; authFailure: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "helm-dispatch", version: "0.1.0" }, { capabilities: {} });
  try {
    // L-1: the grant must still be valid BEFORE initialization transmits the
    // bearer token. A failure here is an authorization change, not an MCP
    // credential failure, and must never pause the credential.
    try {
      await guards?.beforeConnect?.();
    } catch (error) {
      throw new OwnerAuthorizationError(error);
    }
    await client.connect(transport);
    try {
      await guards?.beforeCall?.();
    } catch (error) {
      // Owner-grant failures are not MCP credential failures and must never
      // pause an otherwise valid credential.
      throw new OwnerAuthorizationError(error);
    }
    const r = await client.callTool({ name, arguments: args });
    const content = (r as { content?: unknown }).content;
    const first = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
    return { ok: true, text: typeof first?.text === "string" ? first.text : "" , authFailure: false };
  } catch (e) {
    if (e instanceof OwnerAuthorizationError) throw e;
    const m = String((e as Error)?.message ?? e);
    const authFailure = /invalid_mcp_credential|401|unauthor/i.test(m);
    // Do not forward an upstream body, even after heuristic redaction. Only a
    // fixed local category crosses the action boundary.
    return { ok: false, text: authFailure ? "T3 MCP authentication rejected" : "T3 MCP request failed", authFailure };
  } finally {
    await client.close().catch(() => undefined);
  }
}

class OwnerAuthorizationError extends Error {
  constructor(cause: unknown) {
    super("Owner authorization changed before MCP call", { cause });
  }
}

/**
 * Dispatch one issue thread.
 *
 * Order is deliberate and is the whole point of the wiring:
 *   0. owner grant gate -> no work and no external access without it;
 *   1. provider/target binding -> only the T3 MCP credential may drive the
 *      isolated target; anything else is refused, never substituted;
 *   1b. read the credential gate -> paused stops everything BEFORE any MCP call;
 *   1c. resolve the ISOLATED credentials -> a missing, incomplete or invalid pair
 *       stops everything BEFORE any MCP call and BEFORE an attempt row is
 *       written (nothing was dispatched, so nothing needs reconciling);
 *   2. reserve the durable attempt BEFORE dispatch under the caller's stable
 *      request id, bound to the canonical payload hash. A retry reuses the
 *      existing attempt; a payload mismatch is rejected; a competing id is
 *      blocked while the earlier attempt is unresolved;
 *   3. revalidate the owner grant (again) immediately BEFORE the MCP transport
 *      is constructed — the bearer token is transmitted during initialization;
 *   4. dispatch;
 *   5. on success record the thread id; on an auth failure PAUSE the credential
 *      and mark the attempt ambiguous; on any other failure mark it ambiguous.
 *
 * Step 1c deliberately sits before step 2. A deployment with no isolated
 * configuration has not launched anything, so recording an attempt there would
 * create a phantom "lost acknowledgement" that a human then has to dispose of.
 * Refusing first leaves the attempt table untouched.
 */
export const dispatchIssue = internalAction({
  args: {
    /** Captured owner authority for trusted background work; revalidated on execution. */
    ownerGrant: v.object({
      subject: v.string(),
      issuer: v.string(),
      revision: v.number(),
    }),
    /**
     * Stable request identifier for the logical launch (M-2). The CALLER
     * chooses it and MUST present the same value on every retry of the same
     * logical launch; it becomes the durable attemptId. Retrying with the same
     * requestId and the same payload returns the known outcome without another
     * remote call; an explicit future relaunch uses a NEW requestId, which is
     * what distinguishes it from an accidental retry.
     */
    requestId: v.string(),
    provider: v.string(),
    issueKey: v.string(),
    projectId: v.string(),
    message: v.string(),
    runtimeMode: v.string(),
    /**
     * Test hook: force an auth failure to prove dispatch pauses.
     *
     * Not a back door. This is an argument of an `internalAction`, so it is
     * reachable only from other server-side code that can already call
     * `internal.dispatch.dispatchIssue`; it is unreachable from the browser and
     * from any public HTTP surface. Both `convex/authz.test.ts` and
     * `convex/dispatch.test.ts` assert that boundary from source. Do NOT add a
     * public entry point that forwards this flag: forwarding a test hook
     * through a public function is how a test control becomes an attack surface.
     */
    forceAuthFailure: v.optional(v.boolean()),
    /**
     * Test hook: perform the launch but DISCARD its response, so the attempt is
     * left in the exact state a lost acknowledgment produces. Reconciliation must
     * then find the already-created thread without creating a second one.
     *
     * Same boundary as `forceAuthFailure`: internalAction-only, and never to be
     * re-exported through a public function.
     */
    forceLostAck: v.optional(v.boolean()),
  },
  returns: v.object({
    outcome: v.string(),
    detail: v.string(),
    attemptId: v.union(v.string(), v.null()),
    correlationKey: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
    relaunchAuthorized: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    outcome: string;
    detail: string;
    attemptId: string | null;
    correlationKey: string | null;
    threadId: string | null;
    relaunchAuthorized: boolean;
  }> => {
    // Internal actions and scheduled work do not inherit a browser session.
    // Require the exact current owner grant before any work or external access.
    await ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant);

    // 1. provider/target binding: the isolated T3 dispatch target has exactly
    // one credential provider, "t3-mcp". Any other provider string is a
    // configuration mistake, and silently selecting a different credential for
    // the configured target is precisely what must not happen. Refuse; never
    // substitute. (Exact project mapping remains EGA-679's scope: the
    // projectId is carried verbatim and bound into the payload hash below.)
    if (args.provider !== T3_MCP_PROVIDER) {
      return {
        outcome: "blocked",
        detail: `provider ${args.provider} is not bound to the isolated T3 dispatch target; only ${T3_MCP_PROVIDER} is dispatchable`,
        attemptId: null,
        correlationKey: null,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    if (args.runtimeMode !== REQUIRED_RUNTIME_MODE) {
      return {
        outcome: "blocked",
        detail: `runtime mode is not permitted by server policy; only ${REQUIRED_RUNTIME_MODE} is allowed`,
        attemptId: null,
        correlationKey: null,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // 1b. gate on credential health BEFORE touching the network
    const gate = await ctx.runQuery(internal.credentials.canDispatch, { provider: args.provider });
    if (!gate.allowed) {
      return {
        outcome: "paused",
        detail: gate.reason ?? "dispatch paused",
        attemptId: null,
        correlationKey: null,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // 1c. resolve the ISOLATED credentials. Fail closed BEFORE any MCP call and
    // BEFORE an attempt row is written. `resolveIsolatedDispatchConfig` reads
    // only T3_MCP_URL_ISOLATED / T3_MCP_TOKEN_ISOLATED and refuses anything
    // missing, incomplete, non-https or credential-bearing; the detail names the
    // variable at fault and never its value.
    const isolated = resolveIsolatedDispatchConfig();
    if (!isolated.ok) {
      return {
        outcome: "paused",
        detail: isolatedConfigDetail(isolated),
        attemptId: null,
        correlationKey: null,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // Project binding is checked after ordinary config readiness so operators
    // receive the same missing/invalid credential diagnosis as the transport
    // resolver, while still refusing before reservation or any MCP setup.
    const boundProjectId = resolveIsolatedProjectBinding();
    if (!boundProjectId || args.projectId !== boundProjectId) {
      return {
        outcome: "blocked",
        detail: !boundProjectId
          ? "T3_PROJECT_ID_ISOLATED is not configured; dispatch is disabled until a trusted isolated project is bound"
          : "requested project does not match the configured isolated project; dispatch is disabled",
        attemptId: null,
        correlationKey: null,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // 2. reserve the durable attempt BEFORE dispatch, under the caller's stable
    // request id and bound to the canonical payload hash (M-2). The stored row
    // — never a process-local map — decides whether a remote launch may happen.
    // The reservation throws on: same id with a different payload, or a new id
    // while an earlier attempt for this issue is unresolved.
    const runtimeMode = args.runtimeMode;
    const payloadHash = await canonicalPayloadHash({
      provider: args.provider,
      issueKey: args.issueKey,
      projectId: args.projectId,
      message: args.message,
      runtimeMode,
    });
    const prepared = await ctx.runMutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: args.issueKey,
      targetProjectId: boundProjectId,
      attemptId: args.requestId,
      payloadHash,
    });

    if (prepared.reused) {
      // This exact request has already been reserved. Whatever is already known
      // about it is returned WITHOUT any remote call: a retry can never become a
      // second network launch.
      if (
        (prepared.state === "acknowledged" || prepared.state === "reconciled") &&
        prepared.threadId
      ) {
        return {
          outcome: "dispatched",
          detail: `request already settled (${prepared.state}) as thread ${prepared.threadId}; known result returned without a remote call`,
          attemptId: prepared.attemptId,
          correlationKey: prepared.correlationKey,
          threadId: prepared.threadId,
          relaunchAuthorized: false,
        };
      }
      if (prepared.state === "dispatching") {
        // Another invocation of this request id is mid-dispatch (or died
        // mid-dispatch). The outcome is unknown until acknowledged or
        // reconciled; issuing another launch is exactly the duplicate this
        // boundary exists to prevent.
        return {
          outcome: "in_progress",
          detail:
            "this request id is already dispatching; outcome unknown until acknowledged or reconciled; no second launch issued",
          attemptId: prepared.attemptId,
          correlationKey: prepared.correlationKey,
          threadId: null,
          relaunchAuthorized: false,
        };
      }
      if (prepared.state === "ambiguous") {
        return {
          outcome: "ambiguous",
          detail:
            "an earlier invocation of this request id ended ambiguous; run reconcileAttempt on this attempt id; retrying the request will not relaunch",
          attemptId: prepared.attemptId,
          correlationKey: prepared.correlationKey,
          threadId: prepared.threadId,
          relaunchAuthorized: false,
        };
      }
      if (prepared.state === "abandoned") {
        // An operator explicitly closed this attempt. A further launch is a NEW
        // decision and must present a new request id — that is what separates an
        // authorized relaunch from an accidental retry.
        return {
          outcome: "blocked",
          detail:
            "this request id was abandoned by an operator; an explicit relaunch requires a new request id",
          attemptId: prepared.attemptId,
          correlationKey: prepared.correlationKey,
          threadId: null,
          relaunchAuthorized: false,
        };
      }
      // state === "prepared": the reservation exists but the previous
      // invocation died before issuing any dispatch. markDispatching below is
      // what keeps that safe: exactly one invocation can move the row from
      // prepared to dispatching; every other concurrent caller is refused.
    }

    const dispatchClaimed = await ctx.runMutation(internal.launchAttempts.markDispatching, {
      attemptId: prepared.attemptId,
      at: Date.now(),
    });
    if (!dispatchClaimed) {
      return {
        outcome: "in_progress",
        detail: "another invocation claimed this request id; no second launch was issued",
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    /**
     * L-1 checkpoints for every remote exchange in this action. `beforeConnect`
     * revalidates the owner grant BEFORE the MCP transport initializes — the
     * bearer token is transmitted during initialization, so checking only after
     * connect would send a possibly-revoked grant's credential. `beforeCall`
     * re-rechecks immediately before each tool call.
     */
    const grantGuards: McpGuards = {
      beforeConnect: () =>
        ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
      beforeCall: () =>
        ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
    };

    /**
     * Resolve an ambiguous launch by searching T3 for this attempt's thread.
     *
     * Returns the reconciled state. Never relaunches. A failed search and a
     * zero-match search are deliberately both "ambiguous": we cannot tell the
     * difference between "did not happen" and "cannot see", and both need a human.
     */
    const reconcile = async () => {
      await ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant);
      const found = await findThreadsForCorrelation(
        isolated.endpoint,
        isolated.token,
        prepared.correlationKey,
        args.projectId,
        grantGuards,
      );
      await ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant);
      return await ctx.runMutation(internal.launchAttempts.recordReconciliation, {
        attemptId: prepared.attemptId,
        matchCount: found.matchCount,
        threadId: found.threadId,
      });
    };

    // 3. dispatch (skipped when forceAuthFailure is set, to prove the pause path)
    if (args.forceAuthFailure) {
      await ctx.runMutation(internal.credentials.recordAuthFailure, {
        provider: args.provider,
        at: Date.now(),
        failureClass: "invalid_mcp_credential",
        note: "EGA-677 dispatch proof: forced auth failure",
      });
      const v = await reconcile();
      return {
        outcome: "ambiguous",
        detail: `forced auth failure; credential paused; matches=${v.matchCount}; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    const res = await callTool(isolated.endpoint, isolated.token, "t3_thread_launch", {
      // The correlation key MUST be in the title. It is the only handle a lost
      // acknowledgement leaves behind, so if it is not searchable the attempt can
      // never be reconciled and every lost ack becomes a permanent human decision.
      title: `Helm dispatch ${args.issueKey} ${prepared.correlationKey}`,
      projectId: args.projectId,
      message: args.message,
      runtimeMode,
      // ^ KNOWN MISMATCH, recorded here rather than silently resolved:
      //
      //   - EGA-677's isolated full-access pilot (doc/isolated-fullaccess-proof.md)
      //     is the implemented direction: the isolated instance ran with
      //     `runtimeMode: full-access`, the only mode it has actually executed
      //     under.
      //   - This default remains `approval-required`, the stricter of the two.
      //
      // The default is deliberately NOT changed to match the pilot here. Which
      // runtime mode Helm asks for is an integration decision that belongs with
      // the owner: `approval-required` has never been exercised against the
      // isolated instance, and `full-access` removes approval gating entirely
      // (see "What this proves, and what it does not" in that document).
      // Keeping the stricter default keeps this path fail-closed; choosing
      // otherwise is a later, explicit decision, not a dispatch detail.
      interactionMode: "default",
      modelSelection: { provider: PROVIDER, instanceId: PROVIDER, model: MODEL },
      workspaceStrategy: { type: "root" },
    }, grantGuards);

    // Test hook: the launch really happened, but we behave as if we never heard
    // so back. Everything below must then come from reconciliation alone.
    if (args.forceLostAck) {
      const v = await reconcile();
      const settled =
        v.state === "reconciled" && v.threadId
          ? {
              outcome: "reconciled",
              threadId: v.threadId,
              detail: "lost ack reconciled to the existing thread; not relaunched",
            }
          : {
              outcome: "ambiguous",
              threadId: null,
              detail: `lost ack unresolved (matches=${v.matchCount}); relaunchAuthorized=${v.relaunchAuthorized}`,
            };
      return {
        ...settled,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        relaunchAuthorized: false,
      };
    }

    // 4a. auth failure -> pause the credential, mark ambiguous, never relaunch
    if (!res.ok && res.authFailure) {
      await ctx.runMutation(internal.credentials.recordAuthFailure, {
        provider: args.provider,
        at: Date.now(),
        failureClass: "invalid_mcp_credential",
      });
      const v = await reconcile();
      return {
        outcome: "ambiguous",
        detail: `auth failure; credential paused; matches=${v.matchCount}; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // 4b. definite rejection -> ambiguous (a rejection is not a permission to retry)
    if (!res.ok) {
      const v = await reconcile();
      return {
        outcome: "ambiguous",
        detail: `T3 launch was rejected; reconciliation found ${v.matchCount} matching threads. No relaunch was authorized.`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: false,
      };
    }

    // 4c. success -> acknowledge with the thread id
    let threadId: string | null = null;
    try {
      threadId = (JSON.parse(res.text) as { threadId?: string }).threadId ?? null;
    } catch {
      /* leave null */
    }
    // The thread id is remote-sourced: bound it before trusting it as an
    // identifier. An over-long "id" is not an id, and treating it as one would
    // let a hostile endpoint shape stored state; a missing id is the lost-ack
    // path below.
    if (!isValidT3ThreadId(threadId, isolated.token)) {
      threadId = null;
    }
    if (!threadId) {
      // The genuine lost acknowledgment: T3 may have accepted the launch but the
      // thread id never came back. This is the ONLY path where the launch may
      // have succeeded, so it is the only path that must go and look.
      const v = await reconcile();
      const reconciled =
        v.state === "reconciled" && v.threadId
          ? { outcome: "reconciled", threadId: v.threadId, detail: "reconciled to the existing thread; not relaunched" }
          : {
              outcome: "ambiguous",
              threadId: null,
              detail: `accepted but unresolved (matches=${v.matchCount}); relaunchAuthorized=${v.relaunchAuthorized}`,
            };
      return {
        ...reconciled,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        relaunchAuthorized: false,
      };
    }
    await ctx.runMutation(internal.credentials.recordAuthSuccess, { provider: args.provider, at: Date.now() });
    await ctx.runMutation(internal.launchAttempts.markAcknowledged, {
      attemptId: prepared.attemptId,
      threadId,
      at: Date.now(),
    });
    return {
      outcome: "dispatched",
      detail: "T3 launch acknowledged",
      attemptId: prepared.attemptId,
      correlationKey: prepared.correlationKey,
      threadId,
      relaunchAuthorized: false,
    };
  },
});

/**
 * Re-run reconciliation for an EXISTING attempt.
 *
 * Separate from dispatchIssue because a lost acknowledgment is a standing state:
 * the operator has to be able to come back later, ask "did this launch actually
 * happen?", and get an answer that never duplicates work.
 *
 * Matching is on the attempt's own correlation key, so it can only ever bind to
 * the thread this attempt created. Zero matches and several matches both stay
 * unresolved. This function has no relaunch path at all.
 *
 * It also fails closed: when the isolated configuration is missing, incomplete
 * or invalid it returns the diagnostic `state: "config_blocked"` and records
 * nothing, because there is nothing to search with.
 */
export const reconcileAttempt = internalAction({
  args: {
    attemptId: v.string(),
    projectId: v.string(),
    ownerGrant: v.object({ subject: v.string(), issuer: v.string(), revision: v.number() }),
  },
  returns: v.object({
    state: v.string(),
    matchCount: v.number(),
    threadId: v.union(v.string(), v.null()),
    correlationKey: v.union(v.string(), v.null()),
    relaunchAuthorized: v.literal(false),
    detail: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    state: string;
    matchCount: number;
    threadId: string | null;
    correlationKey: string | null;
    relaunchAuthorized: false;
    detail: string;
  }> => {
    await ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant);
    const attempt = await ctx.runQuery(internal.launchAttempts.getCorrelationForReconciliation, {
      attemptId: args.attemptId,
    });
    if (!attempt) {
      return {
        state: "unknown",
        matchCount: 0,
        threadId: null,
        correlationKey: null,
        relaunchAuthorized: false,
        detail: `unknown attemptId: ${args.attemptId}`,
      };
    }
    // Reconciliation is a read-only path, but it still makes a remote call, so
    // the same fail-closed rule applies: unconfigured, incomplete or invalid
    // isolated configuration must be refused before an MCP client is ever
    // constructed. `state` here is a diagnostic verdict rather than an attempt
    // state, because no reconciliation is recorded in this branch.
    const isolated = resolveIsolatedDispatchConfig();
    if (!isolated.ok) {
      return {
        state: "config_blocked",
        matchCount: 0,
        threadId: null,
        correlationKey: attempt.correlationKey,
        relaunchAuthorized: false,
        detail: `no reconciliation attempted; ${isolatedConfigDetail(isolated)}`,
      };
    }
    const boundProjectId = resolveIsolatedProjectBinding();
    if (!boundProjectId || !attempt.targetProjectId || attempt.targetProjectId !== boundProjectId || args.projectId !== boundProjectId) {
      return {
        state: "target_blocked",
        matchCount: 0,
        threadId: null,
        correlationKey: attempt.correlationKey,
        relaunchAuthorized: false,
        detail: "T3_PROJECT_ID_ISOLATED is missing or differs from the project's durable attempt binding; reconciliation was not run",
      };
    }
    // Same L-1 checkpoint shape as dispatch: the grant is revalidated before
    // the transport initializes (the token is transmitted then) and again
    // immediately before the search tool call.
    const found = await findThreadsForCorrelation(
      isolated.endpoint,
      isolated.token,
      attempt.correlationKey,
      args.projectId,
      {
        beforeConnect: () =>
          ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
        beforeCall: () =>
          ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
      },
    );

    await ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant);
    const rec = await ctx.runMutation(internal.launchAttempts.recordReconciliation, {
      attemptId: args.attemptId,
      matchCount: found.matchCount,
      threadId: found.threadId,
    });

    const why =
      found.searchFailed
        ? "search failed; cannot tell whether the launch happened"
        : found.matchCount === 0
          ? "no thread carries this correlation key"
          : found.matchCount === 1
            ? "exactly one thread carries this correlation key"
            : `${found.matchCount} threads share this correlation key; cannot tell which is ours`;

    return {
      state: rec.state,
      matchCount: found.matchCount,
      threadId: rec.threadId,
      correlationKey: attempt.correlationKey,
      relaunchAuthorized: false,
      detail: `${why}; relaunchAuthorized=false`,
    };
  },
});
