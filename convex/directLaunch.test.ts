/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
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
 * EGA-812 — direct project launch (no Linear issue).
 *
 * There is NO live T3 connection here: every native call is served by the
 * mocked MCP client. What IS proven: the durable intent reservation happens
 * before dispatch, exactly one native `t3_thread_launch` is issued for one
 * intent under concurrency, a changed payload/target is refused, a lost
 * acknowledgement is reconciled by a unique marker (zero/many stay
 * ambiguous), a changed credential namespace is never re-sent, and owner /
 * environment / write-target gates refuse before dispatch.
 */

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ENDPOINT = "https://operate.example.invalid/mcp";
const ENV_ID = "env-op";
const OTHER_ENV_ID = "env-other";
const T3_PROJECT = "t3-proj-1";

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;
type McpCall = { name: string; arguments: Record<string, unknown> };

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function catalogFixture(modelIds: string[] = ["m1"]) {
  return {
    providers: [{
      providerInstanceId: "p1", driverKind: null, displayName: "P1",
      models: modelIds.map((id) => ({ id, label: null, options: null })),
    }],
    features: {
      appOwnedSubagents: false, asyncPolling: false, cancellation: false,
      batchThreadCreation: false, threadManagement: false, incrementalThreadRead: false,
      scheduledTasks: false, maxBatchThreads: null,
    },
    runtimeMode: "approval-required", interactionMode: "default",
    parentThreadId: null, inheritedProviderInstanceId: null, inheritedModel: null,
  };
}

function projectFixture(projectId: string) {
  return {
    id: projectId,
    title: "Direct project",
    status: "active",
    workspaceRoot: "/workspace/direct",
    repositoryIdentity: { canonicalKey: "github.com/ega-builds/direct" },
    defaultModelSelection: { instanceId: "p1", model: "m1" },
  };
}

function launchAck(threadId: string | null, projectId = T3_PROJECT, includeProject = true) {
  const base = includeProject ? { projectId } : {};
  return threadId === null
    ? { ...base, status: "accepted" }
    : { threadId, ...base, runId: "run:thread:ordinal:1", status: "preparing" };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("directLaunch: duplicate-proof direct project launch", () => {
  let savedKeys: Record<string, string | undefined>;
  let launchCalls: { name: string; args: Record<string, unknown> }[];
  let ackThreadId: string | null | undefined;
  let catalogModels: string[];
  /** When false the launch ack omits `projectId` (unproven target). */
  let ackIncludesProjectId: boolean;
  /** When true the thread-list read fails like an unreachable endpoint. */
  let listThrows: boolean;
  /** How many threads the mocked list reports as carrying the launched key. */
  let listMatches: number;
  /** Cross-project collision rows to return alongside the real matches. */
  let foreignProjectMatches: number;

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
    process.env.T3_NATIVE_WRITE_ENDPOINT = ENDPOINT;
    process.env.T3_NATIVE_WRITE_ENVIRONMENTS = `${ENV_ID},${OTHER_ENV_ID}`;

    launchCalls = [];
    ackThreadId = undefined;
    catalogModels = ["m1"];
    ackIncludesProjectId = true;
    listThrows = false;
    listMatches = 0;
    foreignProjectMatches = 0;
    mock.connect.mockReset().mockResolvedValue(undefined);
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.listTools.mockReset();
    mock.callTool.mockReset().mockImplementation(baseCallTool);
  });

  async function baseCallTool(call: McpCall) {
    if (call.name === "t3_environment_read") {
      return textResult({
        environmentId: ENV_ID, label: "Op", serverVersion: "v", platform: "linux/x64", preferences: null,
      });
    }
    if (call.name === "t3_project_read") {
      return textResult(projectFixture(String(call.arguments.projectId ?? T3_PROJECT)));
    }
    if (call.name === "orchestrator_capabilities") return textResult(catalogFixture(catalogModels));
    if (call.name === "t3_thread_launch") {
      launchCalls.push({ name: call.name, args: call.arguments });
      // Distinct native calls get distinct threads, like the real server: the
      // thread id is derived from the request, never reused across intents.
      const threadId = ackThreadId === undefined ? testThreadId(launchCalls.length) : ackThreadId;
      return textResult(launchAck(threadId, String(call.arguments.projectId ?? T3_PROJECT), ackIncludesProjectId));
    }
    if (call.name === "t3_thread_list") {
      if (listThrows) throw new Error("T3 request failed (503)");
      const title = String(launchCalls[0]?.args.title ?? "");
      // The marker is minted first in the title; a long project id can never
      // push it out.
      const key = title.match(/\[helm:direct:[^\]]+\]/)?.[0] ?? "";
      const threads = Array.from({ length: listMatches }, (_, index) => ({
        threadId: testThreadId(10 + index),
        projectId: T3_PROJECT,
        title: `Helm direct ${T3_PROJECT} ${key}`,
      }));
      const foreign = Array.from({ length: foreignProjectMatches }, (_, index) => ({
        threadId: testThreadId(40 + index),
        projectId: "t3-proj-other",
        title: `Helm direct t3-proj-other ${key}`,
      }));
      const all = [...threads, ...foreign];
      return textResult({ projectId: T3_PROJECT, threads: all, nextCursor: null, total: all.length });
    }
    throw new Error(`unexpected tool ${call.name}`);
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
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
    options: { access: "read-only" | "operate"; status?: string; environmentId?: string } = { access: "operate" },
  ): Promise<Id<"t3Connections">> {
    const environmentId = options.environmentId ?? ENV_ID;
    return await t.run(async (ctx) =>
      ctx.db.insert("t3Connections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        endpoint: ENDPOINT, issuer: ENDPOINT, resource: ENDPOINT, clientId: "helm-test-client",
        environmentId, environmentLabel: "Op", serverVersion: "v", platform: "linux/x64",
        access: options.access, status: (options.status ?? "connected") as "connected",
        tokenCiphertext: encryptToken("test-token", ENDPOINT),
        credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(), updatedAt: Date.now(),
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
      }),
    );
  }

  async function ready(t: Harness): Promise<Id<"t3Connections">> {
    return await seedConnection(t, { access: "operate" });
  }

  function authed(t: Harness) {
    return t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
  }

  function directInput(connectionId: Id<"t3Connections">, overrides: Record<string, unknown> = {}) {
    return {
      intentId: "intent-1",
      connectionId,
      environmentId: ENV_ID,
      projectId: T3_PROJECT,
      prompt: "do the direct thing",
      providerInstanceId: "p1",
      model: "m1",
      runtimeMode: "approval-required",
      baseRef: "refs/heads/main",
      ...overrides,
    };
  }

  async function directRows(t: Harness) {
    return await t.run(async (ctx) => await ctx.db.query("directLaunchAttempts").collect());
  }

  async function legacyRows(t: Harness) {
    return await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());
  }

  // ---------------------------------------------------------------------
  // B1 — one native launch per intent
  // ---------------------------------------------------------------------

  it("launches one direct project thread with the reserved identity and native retry key", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));

    expect(result.outcome).toBe("launched");
    expect(result.reason).toBe(null);
    expect(result.relaunchAuthorized).toBe(false);
    expect(result.threadId).toBe(testThreadId(1));
    expect(result.attemptId).toBe("intent-1");
    expect(launchCalls).toHaveLength(1);

    // The reservation existed BEFORE dispatch: the title carries the marker
    // minted at reservation, and the native call carries the reserved key.
    const rows = await directRows(t);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("direct_project");
    expect(row.state).toBe("acknowledged");
    expect(row.attemptId).toBe("intent-1");
    expect(row.projectId).toBe(T3_PROJECT);
    expect(row.environmentId).toBe(ENV_ID);
    expect(row.connectionId).toBe(connectionId);
    expect(row.credentialVersion).toBe(1);
    expect(row.ownerRevision).toBe(1);
    expect(row.threadId).toBe(testThreadId(1));
    expect(row.correlationKey).toBe(result.correlationKey);
    expect(row.clientRequestId).toBe(launchCalls[0]!.args.clientRequestId);

    expect(launchCalls[0]!.args.title).toContain(row.correlationKey);
    expect(launchCalls[0]!.args).toMatchObject({
      projectId: T3_PROJECT,
      modelSelection: { instanceId: "p1", model: "m1" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      message: "do the direct thing",
    });
    const strategy = launchCalls[0]!.args.workspaceStrategy as Record<string, unknown>;
    expect(strategy).toMatchObject({ type: "worktree", baseRef: "refs/heads/main", startFromOrigin: false });
    expect(strategy.branch).toMatch(/^helm\/direct-[0-9a-f]{8}$/);

    // The issue-bound ledger is untouched by the direct path.
    expect(await legacyRows(t)).toHaveLength(0);
  });

  it("a gated double click issues exactly one native launch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const started = deferred();
    const gate = deferred();
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        started.resolve();
        await gate.promise;
        return textResult(launchAck(ackThreadId === undefined ? testThreadId(1) : ackThreadId));
      }
      return await baseCallTool(call);
    });

    const first = authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await started.promise;
    const second = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(second.outcome).toBe("in_progress");
    expect(second.relaunchAuthorized).toBe(false);

    // The durable row is in `dispatching` while the call is still in flight:
    // the transition is persisted BEFORE the remote call.
    const during = await directRows(t);
    expect(during).toHaveLength(1);
    expect(during[0]!.state).toBe("dispatching");
    expect(launchCalls).toHaveLength(1);

    gate.resolve();
    const ack = await first;
    expect(ack.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(1);
    expect((await directRows(t))[0]!.state).toBe("acknowledged");
  });

  it("concurrent identical intents never produce two native launches", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const results = await Promise.all([
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId)),
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId)),
    ]);
    expect(results.every((r) => r.outcome === "launched" || r.outcome === "in_progress")).toBe(true);
    expect(launchCalls).toHaveLength(1);
    expect(await directRows(t)).toHaveLength(1);
  });

  it("a retry of the same intent returns the stored thread without a second launch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.outcome).toBe("launched");
    expect(retry.threadId).toBe(first.threadId);
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // B2 — changed payload / target is refused before dispatch
  // ---------------------------------------------------------------------

  it("refuses the same intent with a changed prompt, model, base ref or project", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(launchCalls).toHaveLength(1);

    const changed = [
      { prompt: "a different launch" },
      { model: "m2" },
      { baseRef: "refs/heads/other" },
      { projectId: "t3-proj-2" },
    ];
    for (const overrides of changed) {
      catalogModels = ["m1", "m2"];
      await expect(
        authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, overrides)),
      ).rejects.toThrow(/different payload|different T3 target/);
    }
    expect(launchCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // B3 — independent intents in one project; no project-wide mutex
  // ---------------------------------------------------------------------

  it("two distinct intents in the same project both launch, with distinct keys", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { intentId: "intent-a" }));
    const second = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { intentId: "intent-b" }));

    expect(first.outcome).toBe("launched");
    expect(second.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(2);
    expect(launchCalls[0]!.args.clientRequestId).not.toBe(launchCalls[1]!.args.clientRequestId);
    expect(first.correlationKey).not.toBe(second.correlationKey);
    expect(first.threadId).not.toBe(second.threadId);
    expect(await directRows(t)).toHaveLength(2);
  });

  it("an ambiguous attempt never blocks a different intent in the same project", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const stuck = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { intentId: "intent-stuck" }));
    expect(stuck.outcome).toBe("ambiguous");

    ackThreadId = undefined;
    listMatches = 0;
    const fresh = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { intentId: "intent-fresh" }));
    expect(fresh.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(2);
    expect((await directRows(t)).map((row) => row.state).sort()).toEqual(["acknowledged", "ambiguous"]);
  });

  // ---------------------------------------------------------------------
  // B4 — lost acknowledgement, zero/many matches
  // ---------------------------------------------------------------------

  it("a lost acknowledgement with zero matches stays ambiguous and never relaunches", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;

    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(first.outcome).toBe("ambiguous");
    expect(first.reason).toBe("ambiguous");
    expect(first.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    expect((await directRows(t))[0]!.state).toBe("ambiguous");

    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);

    const reconciled = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(reconciled.outcome).toBe("ambiguous");
    expect(reconciled.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  it("multiple matches stay ambiguous and never relaunch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 3;
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);
    const row = (await directRows(t))[0]!;
    expect(row.state).toBe("ambiguous");
    expect(row.matchCount).toBe(3);
  });

  it("a thrown dispatch error is reconciled, never retried", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        throw new Error("T3 request failed (503)");
      }
      return await baseCallTool(call);
    });
    listMatches = 0;
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);

    mock.callTool.mockImplementation(async (call: McpCall) => await baseCallTool(call));
    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // B5 — one exact correlation match settles the original attempt
  // ---------------------------------------------------------------------

  it("one exact correlation match settles the original attempt without a relaunch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 1;

    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("launched");
    expect(result.threadId).toBe(testThreadId(10));
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);

    const row = (await directRows(t))[0]!;
    expect(row.state).toBe("reconciled");
    expect(row.threadId).toBe(testThreadId(10));
    expect(row.matchCount).toBe(1);

    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.threadId).toBe(testThreadId(10));
    expect(launchCalls).toHaveLength(1);
  });

  it("a title collision in another project never settles the attempt", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    foreignProjectMatches = 1;

    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("ambiguous");
    expect(result.threadId).toBe(null);
    expect(launchCalls).toHaveLength(1);
    const row = (await directRows(t))[0]!;
    expect(row.state).toBe("ambiguous");
    // The read adapter refuses a page that mixes projects, so the honest
    // result is "incomplete", never "no matches" and never a settle.
    expect(row.note).toMatch(/incomplete/);
    expect(result.detail).toMatch(/could not complete/);
  });

  // ---------------------------------------------------------------------
  // B6 — reconnect / changed credential namespace
  // ---------------------------------------------------------------------

  it("a changed credential namespace is never re-sent and stays explicitly recoverable", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(first.outcome).toBe("ambiguous");
    expect(launchCalls).toHaveLength(1);

    // Reconnect: the same connection row is re-authorised with a new
    // credential version, so the native retry-key namespace changed.
    await t.run(async (ctx) => ctx.db.patch(connectionId, { credentialVersion: 2, updatedAt: Date.now() }));

    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.outcome).toBe("ambiguous");
    expect(retry.reason).toBe("credential_changed");
    expect(retry.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);

    const reconciled = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(reconciled.outcome).toBe("ambiguous");
    expect(reconciled.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // B7 (action side) — reload reads the same durable attempt
  // ---------------------------------------------------------------------

  it("a reload returns the same original attempt and state", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(first.outcome).toBe("ambiguous");

    const byIntent = await authed(t).action(api.directLaunch.recoverDirect, { projectId: T3_PROJECT, environmentId: ENV_ID, intentId: "intent-1" });
    expect(byIntent.outcome).toBe("ambiguous");
    expect(byIntent.latest).toMatchObject({
      attemptId: "intent-1",
      state: "ambiguous",
      correlationKey: first.correlationKey,
      threadId: null,
      projectId: T3_PROJECT,
      environmentId: ENV_ID,
    });

    const byProject = await authed(t).action(api.directLaunch.recoverDirect, { projectId: T3_PROJECT, environmentId: ENV_ID });
    expect(byProject.latest?.attemptId).toBe("intent-1");
    expect(byProject.outcome).toBe("ambiguous");
  });

  // ---------------------------------------------------------------------
  // B8 — owner / target / grant isolation
  // ---------------------------------------------------------------------

  it("denies anonymous, non-owner and revoked callers before any dispatch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const input = directInput(connectionId);

    await expect(t.action(api.directLaunch.launchDirect, input)).rejects.toThrow(/unauthorized/);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(other.action(api.directLaunch.launchDirect, input)).rejects.toThrow(/unauthorized/);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed(t).action(api.directLaunch.launchDirect, input)).rejects.toThrow(/unauthorized/);
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses an environment that does not match the operate connection, before dispatch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const result = await authed(t).action(
      api.directLaunch.launchDirect,
      directInput(connectionId, { environmentId: OTHER_ENV_ID }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses a read-only connection before any dispatch", async () => {
    const t = await granted();
    const readOnlyId = await seedConnection(t, { access: "read-only" });
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(readOnlyId));
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("authorization_required");
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses when the owner-approved write target is not configured", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    delete process.env.T3_NATIVE_WRITE_ENDPOINT;
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("blocked");
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses a project the environment does not serve, before dispatch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_project_read") {
        return textResult(projectFixture("t3-proj-somewhere-else"));
      }
      return await baseCallTool(call);
    });
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("read_failed");
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses a model absent from the live catalogue, before dispatch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    catalogModels = ["m1"];
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { model: "m9" }));
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("model_unavailable");
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  it("refuses a malformed target or base ref as an invalid request", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    await expect(
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { intentId: "bad intent id" })),
    ).rejects.toThrow(/invalid/);
    await expect(
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { baseRef: "main" })),
    ).rejects.toThrow(/invalid/);
    await expect(
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId, { baseRef: "refs/heads/../main" })),
    ).rejects.toThrow(/invalid/);
    expect(launchCalls).toHaveLength(0);
    expect(await directRows(t)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Review repairs (F1/F3/F6/F7) and environment-scoped reload (F2)
  // ---------------------------------------------------------------------

  it("keeps the correlation marker in the title even for a very long project id", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const longProjectId = `t3-${"p".repeat(240)}`;
    const result = await authed(t).action(
      api.directLaunch.launchDirect,
      directInput(connectionId, { projectId: longProjectId }),
    );
    expect(result.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(1);
    const title = String(launchCalls[0]!.args.title);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title).toContain(result.correlationKey!);
  });

  it("does not claim zero matches when the bounded search could not complete", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listThrows = true;
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("ambiguous");
    expect(result.detail).toMatch(/could not complete/);
    expect(result.detail).not.toMatch(/found 0/);

    const reconciled = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(reconciled.outcome).toBe("ambiguous");
    expect(reconciled.detail).toMatch(/could not complete/);
    expect(launchCalls).toHaveLength(1);
  });

  it("does not acknowledge an ack that omits its project; settles only by marker", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackIncludesProjectId = false;
    listMatches = 1;
    // The ack names a thread the reconciliation will not find; the unique
    // marker wins, never the unproven acknowledgement.
    ackThreadId = testThreadId(50);
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("launched");
    expect(result.threadId).toBe(testThreadId(10));
    expect((await directRows(t))[0]!.state).toBe("reconciled");
  });

  it("stays ambiguous when an ack omits its project and no marker match exists", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackIncludesProjectId = false;
    listMatches = 0;
    const result = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(result.outcome).toBe("ambiguous");
    expect(result.relaunchAuthorized).toBe(false);
    expect(launchCalls).toHaveLength(1);
    expect((await directRows(t))[0]!.state).toBe("ambiguous");
  });

  it("a broken credential fails closed before a reservation exists", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const original = await t.run(async (ctx) => (await ctx.db.get(connectionId))!.tokenCiphertext);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { tokenCiphertext: "corrupt" }));

    const blockedResult = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(blockedResult.outcome).toBe("blocked");
    expect(launchCalls).toHaveLength(0);
    // No orphaned reservation to reconcile or abandon.
    expect(await directRows(t)).toHaveLength(0);

    await t.run(async (ctx) => ctx.db.patch(connectionId, { tokenCiphertext: original }));
    const retry = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(retry.outcome).toBe("launched");
    expect(launchCalls).toHaveLength(1);
  });

  it("an owner can explicitly abandon an unresolved intent, and it never relaunches", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    const first = await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    expect(first.outcome).toBe("ambiguous");

    const abandoned = await authed(t).action(api.directLaunch.abandonDirect, {
      intentId: "intent-1",
      note: "operator checked T3",
    });
    expect(abandoned).toEqual({ attemptId: "intent-1", state: "abandoned", abandoned: true });

    const again = await authed(t).action(api.directLaunch.abandonDirect, { intentId: "intent-1" });
    expect(again.abandoned).toBe(false);

    const recovered = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT, environmentId: ENV_ID, intentId: "intent-1",
    });
    expect(recovered.outcome).toBe("abandoned");

    await expect(
      authed(t).action(api.directLaunch.launchDirect, directInput(connectionId)),
    ).rejects.toThrow(/abandoned/);
    expect(launchCalls).toHaveLength(1);
  });

  it("a read-only reconcile during an in-flight dispatch does not cancel the launch", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const started = deferred();
    const gate = deferred();
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        started.resolve();
        await gate.promise;
        return textResult(launchAck(testThreadId(1)));
      }
      return await baseCallTool(call);
    });

    const first = authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await started.promise;
    // A zero-match recovery read while the send is in flight records the
    // durable truth (ambiguous), but it must not cancel a healthy dispatch.
    listMatches = 0;
    const during = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(during.outcome).toBe("ambiguous");
    gate.resolve();

    const ack = await first;
    expect(ack.outcome).toBe("launched");
    expect(ack.threadId).toBe(testThreadId(1));
    expect(launchCalls).toHaveLength(1);
    expect((await directRows(t))[0]!.state).toBe("acknowledged");
  });

  it("classifies an aborted dispatch from the durable abandoned state, not the error text", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const started = deferred();
    const gate = deferred();
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        started.resolve();
        await gate.promise;
        throw new Error("wrapped transport failure");
      }
      return await baseCallTool(call);
    });

    const first = authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await started.promise;
    await authed(t).action(api.directLaunch.abandonDirect, { intentId: "intent-1" });
    gate.resolve();

    const result = await first;
    expect(result.outcome).toBe("abandoned");
    expect(result.relaunchAuthorized).toBe(false);
    expect((await directRows(t))[0]!.state).toBe("abandoned");
    expect(launchCalls).toHaveLength(1);
  });

  it("an in-flight launch survives an operator abandonment: the real thread wins", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const started = deferred();
    const gate = deferred();
    mock.callTool.mockImplementation(async (call: McpCall) => {
      if (call.name === "t3_thread_launch") {
        launchCalls.push({ name: call.name, args: call.arguments });
        started.resolve();
        await gate.promise;
        return textResult(launchAck(testThreadId(1)));
      }
      return await baseCallTool(call);
    });

    const first = authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await started.promise;
    // The dispatch is already in flight; abandonment is the operator's
    // decision about waiting, not a denial that a thread may exist.
    const abandoned = await authed(t).action(api.directLaunch.abandonDirect, { intentId: "intent-1" });
    expect(abandoned.abandoned).toBe(true);
    gate.resolve();

    const ack = await first;
    expect(ack.outcome).toBe("launched");
    expect(ack.threadId).toBe(testThreadId(1));
    const row = (await directRows(t))[0]!;
    expect(row.state).toBe("acknowledged");
    expect(row.threadId).toBe(testThreadId(1));
    expect(launchCalls).toHaveLength(1);

    // The recorded evidence is never lost: reload shows the acknowledged thread.
    const reload = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT, environmentId: ENV_ID, intentId: "intent-1",
    });
    expect(reload.outcome).toBe("acknowledged");
    expect(reload.latest?.threadId).toBe(testThreadId(1));
  });

  it("reconciliation of an abandoned intent respects search completeness and count", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    ackThreadId = null;
    listMatches = 0;
    await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await authed(t).action(api.directLaunch.abandonDirect, { intentId: "intent-1" });

    listThrows = true;
    const incomplete = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(incomplete.outcome).toBe("abandoned");
    expect(incomplete.detail).toMatch(/could not complete/);

    listThrows = false;
    listMatches = 2;
    const many = await authed(t).action(api.directLaunch.reconcileDirect, { intentId: "intent-1" });
    expect(many.outcome).toBe("abandoned");
    expect(many.detail).toMatch(/2 matching threads/);
    expect((await directRows(t))[0]!.state).toBe("abandoned");
  });

  it("cannot abandon a settled intent", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));
    await expect(
      authed(t).action(api.directLaunch.abandonDirect, { intentId: "intent-1" }),
    ).rejects.toThrow(/cannot be abandoned/);
    expect((await directRows(t))[0]!.state).toBe("acknowledged");
  });

  it("connection-scoped reload finds an older attempt behind many newer rows", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    const otherConnectionId = await seedConnection(t, { access: "operate", environmentId: ENV_ID });

    await t.run(async (ctx) => {
      for (let i = 0; i < 51; i++) {
        await ctx.db.insert("directLaunchAttempts", {
          kind: "direct_project",
          ownerSubject: OWNER_SUBJECT,
          ownerIssuer: OWNER_ISSUER,
          ownerRevision: 1,
          connectionId: otherConnectionId,
          credentialVersion: 1,
          environmentId: ENV_ID,
          projectId: T3_PROJECT,
          attemptId: `intent-newer-${i}`,
          payloadHash: "e".repeat(64),
          clientRequestId: `helm-direct-newer-${i}`,
          correlationKey: `[helm:direct:newer${i}]`,
          state: "acknowledged",
          threadId: testThreadId(200 + i),
          dispatchedAt: Date.now(),
          acknowledgedAt: Date.now(),
          matchCount: null,
        });
      }
      await ctx.db.insert("directLaunchAttempts", {
        kind: "direct_project",
        ownerSubject: OWNER_SUBJECT,
        ownerIssuer: OWNER_ISSUER,
        ownerRevision: 1,
        connectionId,
        credentialVersion: 1,
        environmentId: ENV_ID,
        projectId: T3_PROJECT,
        attemptId: "intent-old-mine",
        payloadHash: "f".repeat(64),
        clientRequestId: "helm-direct-old-mine",
        correlationKey: "[helm:direct:oldmine]",
        state: "acknowledged",
        threadId: testThreadId(150),
        dispatchedAt: Date.now(),
        acknowledgedAt: Date.now(),
        matchCount: null,
      });
    });

    const scoped = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT,
      environmentId: ENV_ID,
      connectionId,
    });
    expect(scoped.latest?.attemptId).toBe("intent-old-mine");
    expect(scoped.latest?.threadId).toBe(testThreadId(150));

    const unscoped = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT,
      environmentId: ENV_ID,
    });
    // The unscoped read is bounded to the environment and still returns a
    // durable row. (Seeding many rows in ONE transaction gives them the same
    // creation time, so "which is newest" is not what this test proves; the
    // connection-scoped read above is.)
    expect(unscoped.latest).not.toBe(null);
    expect(unscoped.latest?.environmentId).toBe(ENV_ID);
  });

  it("a reload is environment-scoped: same project id in another environment is not returned", async () => {
    const t = await granted();
    const connectionId = await ready(t);
    await authed(t).action(api.directLaunch.launchDirect, directInput(connectionId));

    // A row for the SAME project id under a DIFFERENT environment (a real T3
    // possibility: project ids are only unique per environment).
    await t.run(async (ctx) =>
      ctx.db.insert("directLaunchAttempts", {
        kind: "direct_project",
        ownerSubject: OWNER_SUBJECT,
        ownerIssuer: OWNER_ISSUER,
        ownerRevision: 1,
        connectionId,
        credentialVersion: 1,
        environmentId: OTHER_ENV_ID,
        projectId: T3_PROJECT,
        attemptId: "intent-other-env",
        payloadHash: "d".repeat(64),
        clientRequestId: "helm-direct-other",
        correlationKey: "[helm:direct:otherenv]",
        state: "acknowledged",
        threadId: testThreadId(99),
        dispatchedAt: Date.now(),
        acknowledgedAt: Date.now(),
        matchCount: null,
      }),
    );

    const here = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT, environmentId: ENV_ID,
    });
    expect(here.latest?.attemptId).toBe("intent-1");
    expect(here.latest?.environmentId).toBe(ENV_ID);

    const there = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT, environmentId: OTHER_ENV_ID,
    });
    expect(there.latest?.attemptId).toBe("intent-other-env");

    const wrongIntentScope = await authed(t).action(api.directLaunch.recoverDirect, {
      projectId: T3_PROJECT, environmentId: OTHER_ENV_ID, intentId: "intent-1",
    });
    expect(wrongIntentScope.latest).toBe(null);
    expect(wrongIntentScope.outcome).toBe("none");
  });
});
