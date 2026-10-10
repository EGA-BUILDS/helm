"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

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
 */

const PROVIDER = "opencode_2";
const MODEL = "opencode/step-5-preview-free";

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
  beforeCall?: () => Promise<void>,
): Promise<{ matchCount: number; threadId: string | null; searchFailed: boolean }> {
  const res = await callTool(endpoint, token, "t3_thread_list", { projectId, limit: 100 }, beforeCall);
  if (!res.ok) return { matchCount: 0, threadId: null, searchFailed: true };
  try {
    const parsed = JSON.parse(res.text) as { threads?: Array<{ threadId?: string; title?: string }> };
    const hits = (parsed.threads ?? []).filter((t) => (t.title ?? "").includes(correlationKey));
    if (hits.length === 1) {
      return { matchCount: 1, threadId: hits[0]!.threadId ?? null, searchFailed: false };
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

/** Stable key so retries of the SAME logical dispatch reuse one attempt. */
export function attemptIdFor(issueKey: string, correlationKey: string): string {
  return `${issueKey}:${correlationKey}`;
}

export async function callTool(
  endpoint: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  beforeCall?: () => Promise<void>,
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
    await client.connect(transport);
    try {
      await beforeCall?.();
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
    return { ok: false, text: m.slice(0, 400), authFailure };
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
 *   1. read the credential gate  -> paused stops everything BEFORE any MCP call;
 *   2. persist the unique attempt BEFORE dispatching;
 *   3. dispatch;
 *   4. on success record the thread id; on an auth failure PAUSE the credential
 *      and mark the attempt ambiguous; on any other failure mark it ambiguous.
 */
export const dispatchIssue = internalAction({
  args: {
    /** Captured owner authority for trusted background work; revalidated on execution. */
    ownerGrant: v.object({
      subject: v.string(),
      issuer: v.string(),
      revision: v.number(),
    }),
    provider: v.string(),
    issueKey: v.string(),
    projectId: v.string(),
    message: v.string(),
    runtimeMode: v.optional(v.string()),
    /** Test hook: force an auth failure to prove dispatch pauses. */
    forceAuthFailure: v.optional(v.boolean()),
    /**
     * Test hook: perform the launch but DISCARD its response, so the attempt is
     * left in the exact state a lost acknowledgment produces. Reconciliation must
     * then find the already-created thread without creating a second one.
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

    // 1. gate on credential health BEFORE touching the network
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

    // 2. persist a unique attempt BEFORE dispatch
    const prepared = await ctx.runMutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: args.issueKey,
      attemptId: `${args.issueKey}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
    });
    await ctx.runMutation(internal.launchAttempts.markDispatching, {
      attemptId: prepared.attemptId,
      at: Date.now(),
    });

    const endpoint = process.env.T3_MCP_URL_ISOLATED ?? process.env.T3_MCP_URL;
    const token = process.env.T3_MCP_TOKEN_ISOLATED ?? process.env.T3_MCP_TOKEN;

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
        endpoint!,
        token!,
        prepared.correlationKey,
        args.projectId,
        () => ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
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

    const res = await callTool(endpoint!, token!, "t3_thread_launch", {
      // The correlation key MUST be in the title. It is the only handle a lost
      // acknowledgement leaves behind, so if it is not searchable the attempt can
      // never be reconciled and every lost ack becomes a permanent human decision.
      title: `Helm dispatch ${args.issueKey} ${prepared.correlationKey}`,
      projectId: args.projectId,
      message: args.message,
      runtimeMode: args.runtimeMode ?? "approval-required",
      interactionMode: "default",
      modelSelection: { provider: PROVIDER, instanceId: PROVIDER, model: MODEL },
      workspaceStrategy: { type: "root" },
    }, () => ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined));

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
        detail: `launch rejected: ${res.text.slice(0, 160)}; matches=${v.matchCount}; relaunchAuthorized=${v.relaunchAuthorized}`,
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
      detail: `launched ${threadId}`,
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

    const endpoint = process.env.T3_MCP_URL_ISOLATED ?? process.env.T3_MCP_URL;
    const token = process.env.T3_MCP_TOKEN_ISOLATED ?? process.env.T3_MCP_TOKEN;
    const found = await findThreadsForCorrelation(
      endpoint!,
      token!,
      attempt.correlationKey,
      args.projectId,
      () => ctx.runQuery(internal.auth.assertCurrentGrant, args.ownerGrant).then(() => undefined),
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
