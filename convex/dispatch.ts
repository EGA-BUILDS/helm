"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

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

/** Normalize an MCP failure into a dispatch decision. */
export type DispatchOutcome =
  | { kind: "dispatched"; threadId: string; runId: string | null }
  | { kind: "paused"; reason: string }
  | { kind: "ambiguous"; detail: string };

/** Stable key so retries of the SAME logical dispatch reuse one attempt. */
export function attemptIdFor(issueKey: string, correlationKey: string): string {
  return `${issueKey}:${correlationKey}`;
}

async function callTool(
  endpoint: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
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
    const r = await client.callTool({ name, arguments: args });
    const content = (r as { content?: unknown }).content;
    const first = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
    return { ok: true, text: typeof first?.text === "string" ? first.text : "" , authFailure: false };
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    const authFailure = /invalid_mcp_credential|401|unauthor/i.test(m);
    return { ok: false, text: m.slice(0, 400), authFailure };
  } finally {
    await client.close().catch(() => undefined);
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
    provider: v.string(),
    issueKey: v.string(),
    projectId: v.string(),
    message: v.string(),
    runtimeMode: v.optional(v.string()),
    /** Test hook: force an auth failure to prove dispatch pauses. */
    forceAuthFailure: v.optional(v.boolean()),
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
    // 1. gate on credential health BEFORE touching the network
    const gate = await ctx.runQuery(api.credentials.canDispatch, { provider: args.provider });
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
    const prepared = await ctx.runMutation(api.launchAttempts.prepareLaunchAttempt, {
      issueKey: args.issueKey,
      attemptId: `${args.issueKey}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
    });
    await ctx.runMutation(api.launchAttempts.markDispatching, {
      attemptId: prepared.attemptId,
      at: Date.now(),
    });

    const endpoint = process.env.T3_MCP_URL_ISOLATED ?? process.env.T3_MCP_URL;
    const token = process.env.T3_MCP_TOKEN_ISOLATED ?? process.env.T3_MCP_TOKEN;

    // 3. dispatch (skipped when forceAuthFailure is set, to prove the pause path)
    if (args.forceAuthFailure) {
      await ctx.runMutation(internal.credentials.recordAuthFailure, {
        provider: args.provider,
        at: Date.now(),
        failureClass: "invalid_mcp_credential",
        note: "EGA-677 dispatch proof: forced auth failure",
      });
      const v = await ctx.runMutation(api.launchAttempts.recordReconciliation, {
        attemptId: prepared.attemptId,
        matchCount: 0,
        threadId: null,
      });
      return {
        outcome: "ambiguous",
        detail: `forced auth failure; credential paused; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: v.relaunchAuthorized,
      };
    }

    const res = await callTool(endpoint!, token!, "t3_thread_launch", {
      title: `Helm dispatch ${args.issueKey}`,
      projectId: args.projectId,
      message: args.message,
      runtimeMode: args.runtimeMode ?? "approval-required",
      interactionMode: "default",
      modelSelection: { provider: PROVIDER, instanceId: PROVIDER, model: MODEL },
      workspaceStrategy: { type: "root" },
    });

    // 4a. auth failure -> pause the credential, mark ambiguous, never relaunch
    if (!res.ok && res.authFailure) {
      await ctx.runMutation(internal.credentials.recordAuthFailure, {
        provider: args.provider,
        at: Date.now(),
        failureClass: "invalid_mcp_credential",
      });
      const v = await ctx.runMutation(api.launchAttempts.recordReconciliation, {
        attemptId: prepared.attemptId,
        matchCount: 0,
        threadId: null,
      });
      return {
        outcome: "ambiguous",
        detail: `auth failure; credential paused; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: v.relaunchAuthorized,
      };
    }

    // 4b. definite rejection -> ambiguous (a rejection is not a permission to retry)
    if (!res.ok) {
      const v = await ctx.runMutation(api.launchAttempts.recordReconciliation, {
        attemptId: prepared.attemptId,
        matchCount: 0,
        threadId: null,
      });
      return {
        outcome: "ambiguous",
        detail: `launch rejected: ${res.text.slice(0, 160)}; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: v.relaunchAuthorized,
      };
    }

    // 4c. success -> acknowledge with the thread id
    let threadId: string | null = null;
    let runId: string | null = null;
    try {
      const parsed = JSON.parse(res.text);
      threadId = parsed.threadId ?? null;
      runId = parsed.runId ?? null;
    } catch {
      /* leave null */
    }
    if (!threadId) {
      // Accepted remotely but we cannot identify the thread: ambiguous, no relaunch.
      const v = await ctx.runMutation(api.launchAttempts.recordReconciliation, {
        attemptId: prepared.attemptId,
        matchCount: 0,
        threadId: null,
      });
      return {
        outcome: "ambiguous",
        detail: `accepted but no threadId parsed; relaunchAuthorized=${v.relaunchAuthorized}`,
        attemptId: prepared.attemptId,
        correlationKey: prepared.correlationKey,
        threadId: null,
        relaunchAuthorized: v.relaunchAuthorized,
      };
    }
    await ctx.runMutation(internal.credentials.recordAuthSuccess, { provider: args.provider, at: Date.now() });
    await ctx.runMutation(api.launchAttempts.markAcknowledged, {
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
