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
 * Native attention contract (EGA-765 v0.2 D11).
 *
 * There is NO live T3 connection here: every remote call is served by the
 * mocked MCP client above. What IS proven: `needs_attention` only with real
 * native evidence (a waiting run), `unknown` when evidence is unavailable
 * (with a T3 handoff reference, never an invented approval API), and that no
 * write tool is ever reached from this read path.
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
const RUN_A = `run:thread:mcp%3A00000000-0000-4000-8000-000000000001:ordinal:1`;

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function envFixture(environmentId = ENV_ID) {
  return { environmentId, label: "Op", serverVersion: "v", platform: "linux/x64", preferences: null };
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
    recentRuns: runs.map((run, index) => ({
      runId: run.runId, ordinal: index + 1, status: run.status,
      providerInstanceId: null, model: null,
      requestedAt: null, startedAt: null, completedAt: null,
    })),
    nextPosition: null,
    hasMore: false,
  };
}

describe("t3Attention: attention derivation from native evidence", () => {
  let savedKeys: Record<string, string | undefined>;
  let toolCalls: { name: string; args: Record<string, unknown> }[];
  let readRuns: { runId: string; status: string | null }[];
  let readProjectId: string;
  let readFailure: string | null;

  beforeEach(() => {
    savedKeys = {
      T3_OAUTH_ENCRYPTION_KEY_VERSION: process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION,
      T3_OAUTH_ENCRYPTION_KEY_V1: process.env.T3_OAUTH_ENCRYPTION_KEY_V1,
      T3_OAUTH_ENCRYPTION_KEY: process.env.T3_OAUTH_ENCRYPTION_KEY,
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;

    toolCalls = [];
    readRuns = [{ runId: RUN_A, status: "starting" }];
    readProjectId = T3_PROJECT;
    readFailure = null;
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
      return textResult(threadFixture(threadId, readProjectId, readRuns));
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
    options: { access: "read-only" | "operate"; status?: string },
  ): Promise<Id<"t3Connections">> {
    return await t.run(async (ctx) =>
      ctx.db.insert("t3Connections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        endpoint: ENDPOINT, issuer: ENDPOINT, resource: ENDPOINT, clientId: "helm-test-client",
        environmentId: ENV_ID, environmentLabel: "Op", serverVersion: "v", platform: "linux/x64",
        access: options.access, status: (options.status ?? "connected") as "connected",
        tokenCiphertext: encryptToken("test-token", ENDPOINT),
        credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(), updatedAt: Date.now(),
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      }),
    );
  }

  function authed(t: Harness) {
    return t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  }

  function attentionInput(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: null as unknown as Id<"t3Connections">,
      projectId: T3_PROJECT,
      threadId: THREAD_A,
      ...overrides,
    };
  }

  it("reports needs_attention only with real waiting-run evidence", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readRuns = [{ runId: RUN_A, status: "awaiting_input" }];
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(result.state).toBe("needs_attention");
    expect(result.basis).toMatch(/waiting/);
    expect(result.observedAt.length).toBeGreaterThan(0);
    // A T3 reference is always present when owner action is needed.
    expect(result.t3Reference).toContain(THREAD_A);
    expect(result.t3Reference).toContain(T3_PROJECT);
  });

  it("reports running for a healthy active run, never needs_attention", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readRuns = [{ runId: RUN_A, status: "starting" }];
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(result.state).toBe("running");
    expect(result.t3Reference).toContain(THREAD_A);
  });

  it("reports idle when every observed run is terminal, and for a runless thread", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readRuns = [{ runId: RUN_A, status: "interrupted" }];
    const terminal = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(terminal.state).toBe("idle");
    readRuns = [];
    const runless = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(runless.state).toBe("idle");
  });

  it("returns unknown when run states carry no decidable signal, naming the pending-request gap", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readRuns = [{ runId: RUN_A, status: null }];
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(result.state).toBe("unknown");
    // The pending-request API is unavailable over the external grant: the
    // basis says so and hands off to T3 instead of inventing an answer.
    expect(result.basis).toMatch(/pending-request evidence is unavailable/);
    expect(result.t3Reference).toContain(THREAD_A);
  });

  it("returns unknown with a handoff when the thread cannot be read", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readFailure = "T3 request failed (503)";
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(result.state).toBe("unknown");
    expect(result.basis.length).toBeGreaterThan(0);
    expect(result.t3Reference).toContain(THREAD_A);
  });

  it("returns unknown with a handoff for an unusable connection, and works over either access level", async () => {
    const t = await granted();
    const dead = await seedConnection(t, { access: "read-only", status: "unreachable" });
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId: dead }));
    expect(result.state).toBe("unknown");
    expect(result.t3Reference).toContain(THREAD_A);
    // A read-only grant can always observe; an operate grant observes too.
    readRuns = [{ runId: RUN_A, status: "starting" }];
    const operateId = await seedConnection(t, { access: "operate" });
    const viaOperate = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId: operateId }));
    expect(viaOperate.state).toBe("running");
  });

  it("returns unknown, never a cross-project state, on project mismatch", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readProjectId = "some-other-project";
    const result = await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    expect(result.state).toBe("unknown");
    expect(result.basis).toMatch(/different project/);
  });

  it("denies anonymous, non-owner, and revoked callers", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(t.action(api.t3Attention.attention, attentionInput({ connectionId }))).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.t3Attention.attention, attentionInput({ connectionId }))).rejects.toThrow(
      /unauthorized/,
    );
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }))).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("never reaches a write tool and never invents an approval-response API", async () => {
    const t = await granted();
    const connectionId = await seedConnection(t, { access: "read-only" });
    readRuns = [{ runId: RUN_A, status: "awaiting_input" }];
    await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    readRuns = [{ runId: RUN_A, status: "starting" }];
    await authed(t).action(api.t3Attention.attention, attentionInput({ connectionId }));
    const names = toolCalls.map((call) => call.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/launch|send|interrupt/);
    }
    expect(new Set(names)).toEqual(new Set(["t3_environment_read", "t3_thread_read"]));
    const src = readFileSync(join(import.meta.dirname, "t3Attention.ts"), "utf8");
    expect(src).not.toMatch(/t3_thread_launch/);
    expect(src).not.toMatch(/t3_thread_send/);
    expect(src).not.toMatch(/t3_thread_interrupt/);
    // No approval-response tool is referenced as callable: the handoff goes
    // to T3 instead.
    expect(src).not.toMatch(/t3_pending_request_respond/);
    expect(src).not.toMatch(/operateToolCall/);
    expect(src).not.toMatch(/\.delete\(/);
  });
});
