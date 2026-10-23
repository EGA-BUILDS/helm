/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const mock = vi.hoisted(() => ({ connect: vi.fn(), callTool: vi.fn(), close: vi.fn(), listTools: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(...args: unknown[]) { return mock.connect(...args); }
    callTool(...args: unknown[]) { return mock.callTool(...args); }
    listTools(...args: unknown[]) { return mock.listTools(...args); }
    close(...args: unknown[]) { return mock.close(...args); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

/**
 * Native interrupt contract (EGA-765 v0.2 D11).
 *
 * There is NO live T3 connection here, so the interrupt path's live behaviour
 * is NOT tested: every remote call is served by the mocked MCP client above.
 * What IS proven: the permission boundary (read-only can never reach the
 * interrupt tool, before any network call), the server-side run recheck
 * (stale/cross-thread ids refused, terminal/idle runs neutral, no delete,
 * no retry, requested-not-verified reporting), and that no launch/send call
 * is ever made from these paths.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ENDPOINT = "https://operate.example.invalid/mcp";
const ENV_ID = "env-op";
const T3_PROJECT = "t3-proj-1";

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const THREAD_A = testThreadId(1);
const THREAD_B = testThreadId(2);
const RUN_A = `run:thread:mcp%3A00000000-0000-4000-8000-000000000001:ordinal:1`;
const RUN_B = `run:thread:mcp%3A00000000-0000-4000-8000-000000000002:ordinal:1`;

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function envFixture(environmentId = ENV_ID) {
  return { environmentId, label: "Op", serverVersion: "v", platform: "linux/x64", preferences: null };
}

function runEntry(runId: string, status: string | null, ordinal = 1) {
  return {
    runId, ordinal, status, providerInstanceId: null, model: null,
    requestedAt: null, startedAt: null, completedAt: null,
  };
}

function threadFixture(threadId: string, projectId: string, runs: { runId: string; status: string | null }[]) {
  return {
    thread: {
      threadId, projectId, title: "probe thread", status: "active",
      providerInstanceId: null, model: null, runtimeMode: null, interactionMode: null,
      branch: null, worktreePath: null, latestRunId: runs[0]?.runId ?? null,
      parentThreadId: null, linkedPullRequest: null, updatedAt: null,
    },
    items: [],
    recentRuns: runs.map((run, index) => runEntry(run.runId, run.status, index + 1)),
    nextPosition: null,
    hasMore: false,
  };
}

describe("t3Interrupt: native run interrupt", () => {
  let savedKeys: Record<string, string | undefined>;
  let toolCalls: { name: string; args: Record<string, unknown> }[];
  /** Runs the mocked native thread read reports for the requested thread. */
  let readRuns: { runId: string; status: string | null }[];
  /** Project the mocked native thread read reports. */
  let readProjectId: string;
  /** Status the mocked native interrupt answers with. */
  let interruptStatus: string;
  /** When set, the mocked thread read throws this message instead. */
  let readFailure: string | null;
  /** When set, the mocked native interrupt throws this message after dispatch. */
  let interruptFailure: string | null;
  /** Per-thread run lists; falls back to `readRuns` for unknown threads. */
  let readRunsByThread: Record<string, { runId: string; status: string | null }[]> | null;

  beforeEach(() => {
    savedKeys = {
      T3_OAUTH_ENCRYPTION_KEY_VERSION: process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION,
      T3_OAUTH_ENCRYPTION_KEY_V1: process.env.T3_OAUTH_ENCRYPTION_KEY_V1,
      T3_OAUTH_ENCRYPTION_KEY: process.env.T3_OAUTH_ENCRYPTION_KEY,
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
      T3_NATIVE_WRITE_ENDPOINT: process.env.T3_NATIVE_WRITE_ENDPOINT,
      T3_NATIVE_WRITE_ENVIRONMENTS: process.env.T3_NATIVE_WRITE_ENVIRONMENTS,
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    // The owner-approved native write target, matching the seeded operate
    // connection. Tests that exercise refusals remove or change these.
    process.env.T3_NATIVE_WRITE_ENDPOINT = ENDPOINT;
    process.env.T3_NATIVE_WRITE_ENVIRONMENTS = ENV_ID;

    toolCalls = [];
    readRuns = [{ runId: RUN_A, status: "starting" }];
    readProjectId = T3_PROJECT;
    interruptStatus = "interrupt_requested";
    readFailure = null;
    interruptFailure = null;
    readRunsByThread = null;
    mock.connect.mockReset().mockResolvedValue(undefined);
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.listTools.mockReset();
    mock.callTool.mockReset().mockImplementation(baseCallTool);
  });

  type McpCall = { name: string; arguments: Record<string, unknown> };

  async function baseCallTool(call: McpCall) {
    toolCalls.push({ name: call.name, args: call.arguments });
    if (call.name === "t3_environment_read") return textResult(envFixture());
    if (call.name === "t3_thread_read") {
      if (readFailure) throw new Error(readFailure);
      const threadId = String((call.arguments as Record<string, unknown>).threadId ?? THREAD_A);
      return textResult(threadFixture(threadId, readProjectId, readRunsByThread?.[threadId] ?? readRuns));
    }
    if (call.name === "t3_thread_interrupt") {
      if (interruptFailure) throw new Error(interruptFailure);
      const args = call.arguments as Record<string, unknown>;
      return textResult({ threadId: args.threadId, runId: args.runId, status: interruptStatus });
    }
    throw new Error(`unexpected tool ${call.name}`);
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function encryptToken(plaintext: string, endpoint: string): string {
    const key = Buffer.from(process.env.T3_OAUTH_ENCRYPTION_KEY_V1!, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`token:${OWNER_ISSUER}:${OWNER_SUBJECT}:${endpoint}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedConnection(
    t: Harness,
    options: { access: "read-only" | "operate"; status?: string; endpoint?: string; environmentId?: string },
  ): Promise<Id<"t3Connections">> {
    const endpoint = options.endpoint ?? ENDPOINT;
    const environmentId = options.environmentId ?? ENV_ID;
    return await t.run(async (ctx) =>
      ctx.db.insert("t3Connections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        endpoint, issuer: endpoint, resource: endpoint, clientId: "helm-test-client",
        environmentId, environmentLabel: "Op", serverVersion: "v", platform: "linux/x64",
        access: options.access, status: (options.status ?? "connected") as "connected",
        tokenCiphertext: encryptToken("test-token", endpoint),
        credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(), updatedAt: Date.now(),
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      }),
    );
  }

  function authed(t: Harness) {
    return t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  }

  function interruptInput(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: null as unknown as Id<"t3Connections">,
      projectId: T3_PROJECT,
      threadId: THREAD_A,
      runId: RUN_A,
      ...overrides,
    };
  }

  async function ready(t: Harness) {
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const operateId = await seedConnection(t, { access: "operate" });
    return { readonlyId, operateId };
  }

  function interruptNames() {
    return toolCalls.filter((call) => call.name === "t3_thread_interrupt");
  }

  it("interrupts an active run and reports requested, not verified", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    const result = await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    expect(result.outcome).toBe("requested");
    expect(result.reason).toBe(null);
    // Requested is never described as verified termination.
    expect(result.detail).toMatch(/accepted/);
    expect(result.detail).toMatch(/not verified as terminated/);
    expect(result.detail).not.toMatch(/has terminated|verified termination/);
    expect(result.threadId).toBe(THREAD_A);
    expect(result.runId).toBe(RUN_A);
    expect(result.t3Reference).toContain(THREAD_A);
    expect(interruptNames()).toHaveLength(1);
    expect(interruptNames()[0]!.args).toMatchObject({ threadId: THREAD_A, runId: RUN_A });
  });

  it("a read-only connection cannot interrupt, before any network call", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: readonlyId }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/operate/);
    expect(interruptNames()).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("missing operate grant refuses with the specific reason", async () => {
    const t = await granted();
    const readonlyId = await seedConnection(t, { access: "read-only" });
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: readonlyId }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(interruptNames()).toHaveLength(0);
  });

  it("an ambiguous operate inventory refuses without choosing", async () => {
    const t = await granted();
    await seedConnection(t, { access: "operate" });
    const second = await seedConnection(t, { access: "operate" });
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: second }),
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toMatch(/ambiguous/);
    expect(interruptNames()).toHaveLength(0);
  });

  it("revoked, expired, and unreachable operate grants refuse with specific reasons, before any network call", async () => {
    for (const [status, reason] of [
      ["reauthorizationRequired", "authorization_required"],
      ["expired", "expired"],
      ["unreachable", "unreachable"],
    ] as const) {
      const t = await granted();
      const operateId = await seedConnection(t, { access: "operate", status });
      const result = await authed(t).action(
        api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
      );
      expect(result.outcome, status).toBe("rejected");
      expect(result.reason, status).toBe(reason);
      expect(interruptNames(), status).toHaveLength(0);
      // Refusal happens before any MCP transport is constructed: not even
      // the bearer-token handshake reaches the network.
      expect(mock.connect, status).not.toHaveBeenCalled();
    }
  });

  it("denies anonymous, non-owner, and stale-revision callers", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }))).rejects.toThrow(
      /unauthorized/,
    );
    await expect(other.action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }))).rejects.toThrow(
      /unauthorized/,
    );
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }))).rejects.toThrow(
      /unauthorized/,
    );
    expect(interruptNames()).toHaveLength(0);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("a stale grant revision makes the operate connection unusable", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(interruptNames()).toHaveLength(0);
  });

  it("a stale run id is refused and never interrupts a different run", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId, runId: "run:thread:nope:ordinal:9" }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("invalid_run");
    expect(interruptNames()).toHaveLength(0);
  });

  it("a run from another thread is refused and never interrupts this thread's run", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    // The native read of THREAD_A reports only RUN_A; presenting RUN_B (a run
    // of THREAD_B) must refuse, never dispatch against either run.
    readRuns = [{ runId: RUN_A, status: "starting" }];
    const result = await authed(t).action(
      api.t3Interrupt.interrupt,
      interruptInput({ connectionId: operateId, threadId: THREAD_A, runId: RUN_B }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("invalid_run");
    expect(interruptNames()).toHaveLength(0);
    void THREAD_B;
  });

  it("an already-terminal run returns a neutral outcome with no interrupt call", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readRuns = [{ runId: RUN_A, status: "interrupted" }];
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("already_terminal");
    expect(result.reason).toBe("already_terminal");
    expect(interruptNames()).toHaveLength(0);
  });

  it("an idle thread returns a neutral no_active_run outcome and deletes nothing", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readRuns = [];
    const before = await t.run(async (ctx) => await ctx.db.query("t3Connections").collect());
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("no_active_run");
    expect(result.reason).toBe("no_active_run");
    expect(result.runId).toBe(null);
    expect(result.detail).toMatch(/nothing was deleted/);
    expect(interruptNames()).toHaveLength(0);
    const after = await t.run(async (ctx) => await ctx.db.query("t3Connections").collect());
    expect(after.map((row) => row._id)).toEqual(before.map((row) => row._id));
  });

  it("a repeated interrupt of the same run issues no duplicate side effect", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    const first = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(first.outcome).toBe("requested");
    expect(interruptNames()).toHaveLength(1);
    // The second call re-reads first: the run is now interrupted, so the
    // recheck short-circuits before any second interrupt call.
    readRuns = [{ runId: RUN_A, status: "interrupted" }];
    const second = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(second.outcome).toBe("already_terminal");
    expect(interruptNames()).toHaveLength(1);
  });

  it("an in-flight interrupt is reported as requested, not settled, without a second call", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readRuns = [{ runId: RUN_A, status: "interrupt_requested" }];
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("already_terminal");
    // `interrupt_requested` is a REQUEST, never verified termination: the
    // UI receives its own reason so it cannot render "Already terminal".
    expect(result.reason).toBe("inflight_interrupt");
    expect(result.detail).toMatch(/already in flight/);
    expect(result.detail).toMatch(/NOT settled/);
    expect(result.detail).not.toMatch(/terminated/i);
    expect(interruptNames()).toHaveLength(0);
  });

  it("an unclear acknowledgement stays ambiguous after dispatch and never retries", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    interruptStatus = "mysterious";
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("ambiguous");
    // The call was sent, so this is post-dispatch ambiguity.
    expect(result.reason).toBe("dispatch_outcome_unknown");
    expect(result.detail).toMatch(/was sent/i);
    expect(interruptNames()).toHaveLength(1);
  });

  it("a lost acknowledgement after dispatch is potentially-applied ambiguity, never a refusal or a retry", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    for (const lost of ["T3 request timed out", "T3 request failed (500)", "T3 endpoint could not be reached"]) {
      interruptFailure = lost;
      const result = await authed(t).action(
        api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
      );
      // "We sent it, we don't know if it applied": ambiguous, NOT the
      // pre-dispatch refusal vocabulary (`rejected`/`unreachable`).
      expect(result.outcome, lost).toBe("ambiguous");
      expect(result.reason, lost).toBe("dispatch_outcome_unknown");
      expect(result.outcome, lost).not.toBe("rejected");
      expect(result.reason, lost).not.toBe("unreachable");
      expect(result.detail, lost).toMatch(/was sent/iu);
      expect(result.detail, lost).toMatch(/No retry was issued/iu);
      // The dispatch happened exactly once and no retry was issued from
      // this path against the lost acknowledgement.
      expect(interruptNames(), lost).toHaveLength(1);
      toolCalls = [];
      interruptFailure = null;
    }
  });

  it("an unrecognized run status is pre-dispatch ambiguity: nothing is sent, never a confident label", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readRuns = [{ runId: RUN_A, status: "transmuted" }];
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toMatch(/no interruption was issued/i);
    expect(interruptNames()).toHaveLength(0);
  });

  it("interrupting one of two concurrently running threads never dispatches against the other", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readRunsByThread = {
      [THREAD_A]: [{ runId: RUN_A, status: "running" }],
      [THREAD_B]: [{ runId: RUN_B, status: "running" }],
    };
    readRuns = [{ runId: RUN_A, status: "running" }];
    const result = await authed(t).action(
      api.t3Interrupt.interrupt,
      interruptInput({ connectionId: operateId, threadId: THREAD_A, runId: RUN_A }),
    );
    expect(result.outcome).toBe("requested");
    expect(result.threadId).toBe(THREAD_A);
    expect(result.runId).toBe(RUN_A);
    expect(interruptNames()).toHaveLength(1);
    const only = interruptNames()[0]!;
    expect(only.args.threadId).toBe(THREAD_A);
    expect(only.args.runId).toBe(RUN_A);
    // No tool call ever named THREAD_B's run: the other thread is untouched.
    for (const call of toolCalls) {
      expect(JSON.stringify(call.args)).not.toContain(RUN_B);
    }
  });

  it("a thread from a different project is refused without interrupting", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readProjectId = "some-other-project";
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("project_mismatch");
    expect(interruptNames()).toHaveLength(0);
  });

  it("an unverifiable thread read stays ambiguous and never interrupts", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    readFailure = "T3 request failed (500)";
    const result = await authed(t).action(
      api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }),
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("ambiguous");
    expect(interruptNames()).toHaveLength(0);
  });

  it("refuses an interrupt when the approved write target is unconfigured", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    delete process.env.T3_NATIVE_WRITE_ENDPOINT;
    const result = await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/approved write endpoint is not configured/);
    expect(interruptNames()).toHaveLength(0);
    expect(toolCalls).toHaveLength(0);
  });

  it("refuses an interrupt to an unapproved environment before any network call", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    process.env.T3_NATIVE_WRITE_ENVIRONMENTS = "env-real-relay";
    const result = await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("authorization_required");
    expect(result.detail).toMatch(/approved write environment/);
    expect(interruptNames()).toHaveLength(0);
    expect(toolCalls).toHaveLength(0);
  });

  it("refuses invalid request shapes without any network call", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    await expect(
      authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId, threadId: "nope" })),
    ).rejects.toThrow(/interrupt request is invalid/);
    await expect(
      authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId, runId: "" })),
    ).rejects.toThrow(/interrupt request is invalid/);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("never asks the native client for launch or send from these paths", async () => {
    const t = await granted();
    const { operateId } = await ready(t);
    // Exercise every dispatching branch: success, unclear ack, failure.
    await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    interruptStatus = "mysterious";
    await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    readRuns = [{ runId: RUN_A, status: "interrupted" }];
    await authed(t).action(api.t3Interrupt.interrupt, interruptInput({ connectionId: operateId }));
    const names = toolCalls.map((call) => call.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/launch|send/);
    }
    expect(new Set(names)).toEqual(new Set(["t3_environment_read", "t3_thread_read", "t3_thread_interrupt"]));
  });

  it("the interrupt module cannot reach launch or send, deletes nothing, and reuses the shared gates", () => {
    const src = readFileSync(join(import.meta.dirname, "t3Interrupt.ts"), "utf8");
    expect(src).not.toMatch(/t3_thread_launch/);
    expect(src).not.toMatch(/t3_thread_send/);
    expect(src).toMatch(/t3_thread_interrupt/);
    expect(src).toMatch(/resolveOperateConnection/);
    expect(src).toMatch(/isValidT3ThreadId/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/disconnect/);
  });
});
