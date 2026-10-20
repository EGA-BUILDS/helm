/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";
import { LINEAR_ISSUE_DETAIL_QUERY } from "./lib/linearIssues";
import { LINEAR_TEAM_STATES_QUERY } from "./lib/linearGraphql";

/**
 * B3: the launch path -> scheduler wiring.
 *
 * The product trigger only exists if the LAUNCH path schedules it, so this
 * file drives the real launch action (with the MCP client mocked) and then
 * counts what was scheduled and what was written to Linear once the
 * scheduled functions ran.
 */

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

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };
const modules = import.meta.glob("./**/*.ts");
const ENDPOINT = "https://operate.example.invalid/mcp";
const ENV_ID = "env-op";
const T3_PROJECT = "t3-proj-1";
const ISSUE_ID = "issue-uuid-1";
const LINEAR_GRAPHQL_HOST = "https://api.linear.app/graphql";

function testThreadId(n: number): string {
  return `mcp:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function envFixture() {
  return { environmentId: ENV_ID, label: "Op", serverVersion: "v", platform: "linux/x64", preferences: null };
}

function catalogFixture() {
  return {
    providers: [{
      providerInstanceId: "p1", driverKind: null, displayName: "P1",
      models: [{ id: "m1", label: null, options: null }],
      runtimeModes: null, canRunChildTask: false, canRunCrossProviderChildTask: false,
      authenticationStatus: null, availability: null, constraints: null,
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

function launchInput(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: ISSUE_ID,
    linearIssueIdentifier: "EGA-762",
    prompt: "do the thing",
    providerInstanceId: "p1",
    model: "m1",
    runtimeMode: "approval-required",
    useSubagents: false,
    expectedLatestAttemptId: null,
    ...overrides,
  };
}

const TEAM_STATES_ENG = {
  data: { team: { id: "team-eng", key: "ENG", name: "Engineering", organization: { id: "ws-1" },
    states: { nodes: [
      { id: "s-backlog", name: "Backlog", type: "unstarted" },
      { id: "s-progress", name: "In Progress", type: "started" },
    ] } } },
};

function issuePayload(issueId: string, stateId: string) {
  const state = stateId === "s-progress"
    ? { id: "s-progress", name: "In Progress", type: "started" }
    : { id: "s-backlog", name: "Backlog", type: "unstarted" };
  return {
    data: {
      organization: { id: "ws-1" },
      issue: {
        id: issueId, identifier: "EGA-762", title: "Native launch", url: "https://linear.app/helm/issue/EGA-762",
        priority: 2, priorityLabel: "High", state,
        team: { id: "team-eng", key: "ENG", name: "Engineering" },
        assignee: null, description: "Ship the launch.",
        project: { id: "proj-1" },
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
      },
    },
  };
}

describe("B3 launch -> scheduler wiring", () => {
  let savedKeys: Record<string, string | undefined>;
  const linearCalls = { detail: 0, states: 0, mutation: 0 };

  beforeEach(() => {
    savedKeys = {
      T3_OAUTH_ENCRYPTION_KEY_VERSION: process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION,
      T3_OAUTH_ENCRYPTION_KEY_V1: process.env.T3_OAUTH_ENCRYPTION_KEY_V1,
      T3_OAUTH_ENCRYPTION_KEY: process.env.T3_OAUTH_ENCRYPTION_KEY,
      LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION,
      LINEAR_OAUTH_ENCRYPTION_KEY_V1: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1,
      LINEAR_OAUTH_ENCRYPTION_KEY: process.env.LINEAR_OAUTH_ENCRYPTION_KEY,
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
    };
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("l".repeat(32)).toString("base64");
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;

    linearCalls.detail = 0;
    linearCalls.states = 0;
    linearCalls.mutation = 0;
    mock.connect.mockReset().mockResolvedValue(undefined);
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.listTools.mockReset();
    mock.callTool.mockReset().mockImplementation(async (call: { name: string }) => {
      if (call.name === "t3_environment_read") return textResult(envFixture());
      if (call.name === "orchestrator_capabilities") return textResult(catalogFixture());
      if (call.name === "t3_thread_launch") {
        return textResult({ threadId: testThreadId(1), projectId: T3_PROJECT, runId: "run:1", status: "preparing" });
      }
      throw new Error(`unexpected tool ${call.name}`);
    });
    stubLinear();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  /** One stub for BOTH the launch's issue read and the sync's reads/writes. */
  function stubLinear() {
    let state = "s-backlog";
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      if (String(input) !== LINEAR_GRAPHQL_HOST) throw new Error(`unexpected target: ${String(input)}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: { issueId?: string } };
      const issueId = body.variables?.issueId ?? ISSUE_ID;
      if (body.query.startsWith("mutation")) {
        linearCalls.mutation += 1;
        state = "s-progress";
        return new Response(JSON.stringify({ data: { issueStateUpdate: { success: true } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_TEAM_STATES_QUERY) {
        linearCalls.states += 1;
        return new Response(JSON.stringify(TEAM_STATES_ENG), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (body.query === LINEAR_ISSUE_DETAIL_QUERY || body.query.includes("issue(id:")) {
        linearCalls.detail += 1;
        return new Response(JSON.stringify(issuePayload(issueId, state)), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected Linear query: ${body.query.slice(0, 60)}`);
    });
  }

  function encryptToken(plaintext: string, endpoint: string): string {
    const key = Buffer.from(process.env.T3_OAUTH_ENCRYPTION_KEY_V1!, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`token:${OWNER_ISSUER}:${OWNER_SUBJECT}:${endpoint}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  async function ready() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const t3ConnectionId = await t.run(async (ctx) => ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: ENDPOINT, issuer: ENDPOINT, resource: ENDPOINT, clientId: "helm-test-client",
      environmentId: ENV_ID, environmentLabel: "Op", serverVersion: "v", platform: "linux/x64",
      access: "operate", status: "connected", tokenCiphertext: encryptToken("test-token", ENDPOINT),
      credentialVersion: 1, expiresAt: Date.now() + 3_600_000, createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner, linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: ENV_ID, t3ProjectId: T3_PROJECT, t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main",
      startedStateId: "s-progress", startedStateName: "In Progress", at: Date.now(),
    });
    await t.run(async (ctx) => ctx.db.insert("linearConnections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
      accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null, credentialVersion: 1,
      scopes: ["read", "write"], status: "connected", lastVerifiedAt: null, lastSuccessfulReadAt: null,
      lastErrorCode: null, clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    return { t, t3ConnectionId };
  }

  async function scheduledFunctions(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  }

  it("two launches of the same attempt schedule exactly ONE sync, and it writes Linear once (F7/F10)", async () => {
    const { t } = await ready();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });

    const first = await authed.action(api.t3Launch.launch, launchInput());
    expect(first.outcome).toBe("launched");
    expect(first.threadId).toBe(testThreadId(1));

    // The association was recorded and the sync was scheduled.
    const afterFirst = await scheduledFunctions(t);
    expect(afterFirst).toHaveLength(1);

    // The supported reload-recovery path: the SAME attempt again. The
    // association already exists, so no second sync is scheduled.
    const second = await authed.action(api.t3Launch.launch, launchInput());
    expect(second.outcome).toBe("launched");
    expect(second.threadId).toBe(first.threadId);
    const afterSecond = await scheduledFunctions(t);
    expect(afterSecond).toHaveLength(1);

    // Now run the scheduled function: it drives the Linear sync exactly once.
    await t.finishAllScheduledFunctions(() => {});
    expect(linearCalls.mutation).toBe(1);

    // The ledger row of the association is `synced` — the trigger really
    // drove the sync, it did not just schedule something.
    const rows = await t.run(async (ctx) => ctx.db.query("linearSyncLedger").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "synced", attemptCount: 1 });
  });

  it("a launch that records NO association schedules nothing (F7)", async () => {
    const { t } = await ready();
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    // A launch whose attempt is refused (a different payload on the same
    // attempt id) never records an association, so it must never schedule.
    await authed.action(api.t3Launch.launch, launchInput());
    await expect(
      authed.action(api.t3Launch.launch, launchInput({ prompt: "a different launch" })),
    ).rejects.toThrow(/does not match its reservation/);
    const jobs = await scheduledFunctions(t);
    expect(jobs).toHaveLength(1);
  });
});
