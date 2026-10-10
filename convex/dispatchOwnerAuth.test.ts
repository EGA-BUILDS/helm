/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { callTool } from "./dispatch";

const mcp = vi.hoisted(() => ({ connect: vi.fn(), callTool: vi.fn(), close: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(...args: unknown[]) { return mcp.connect(...args); }
    callTool(...args: unknown[]) { return mcp.callTool(...args); }
    close(...args: unknown[]) { return mcp.close(...args); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const ENVIRONMENT = "environment-placeholder";
const modules = import.meta.glob("./**/*.ts");

describe("owner grant enforcement for background dispatch", () => {
  let previousSubject: string | undefined;
  let previousIssuer: string | undefined;
  let previousEndpoint: string | undefined;
  let previousToken: string | undefined;
  let previousProject: string | undefined;
  let previousEnvironment: string | undefined;

  beforeEach(() => {
    previousSubject = process.env.HELM_OWNER_SUBJECT;
    previousIssuer = process.env.CLERK_FRONTEND_API_URL;
    previousEndpoint = process.env.T3_MCP_URL_ISOLATED;
    previousToken = process.env.T3_MCP_TOKEN_ISOLATED;
    previousProject = process.env.T3_PROJECT_ID_ISOLATED;
    previousEnvironment = process.env.T3_ENVIRONMENT_ID;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    process.env.T3_PROJECT_ID_ISOLATED = "project-placeholder";
    process.env.T3_ENVIRONMENT_ID = ENVIRONMENT;
  });

  afterEach(() => {
    if (previousSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = previousSubject;
    if (previousIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = previousIssuer;
    if (previousEndpoint === undefined) delete process.env.T3_MCP_URL_ISOLATED;
    else process.env.T3_MCP_URL_ISOLATED = previousEndpoint;
    if (previousToken === undefined) delete process.env.T3_MCP_TOKEN_ISOLATED;
    else process.env.T3_MCP_TOKEN_ISOLATED = previousToken;
    if (previousProject === undefined) delete process.env.T3_PROJECT_ID_ISOLATED;
    else process.env.T3_PROJECT_ID_ISOLATED = previousProject;
    if (previousEnvironment === undefined) delete process.env.T3_ENVIRONMENT_ID;
    else process.env.T3_ENVIRONMENT_ID = previousEnvironment;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function prepareDispatch(t: ReturnType<typeof convexTest>) {
    const grant = await t.mutation(internal.auth.grantOwner, {
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read", "orchestration:operate"],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(internal.projects.upsertTrustedMapping, {
      repository: "EGA-BUILDS/helm",
      linearProjectId: "12345678-1234-5678-1234-567812345678",
      t3EnvironmentId: ENVIRONMENT,
      t3ProjectId: "project-placeholder",
      baseRef: "main",
      ownerSubject: OWNER_SUBJECT,
    });
    const target = await t.query(internal.projects.trustedTarget, {});
    if (!target) throw new Error("test project mapping missing");
    await t.run((ctx) => ctx.db.insert("serviceConnections", {
      projectId: target.id,
      kind: "t3",
      configuredIdentity: `${ENVIRONMENT}/project-placeholder`,
      status: "connected",
      generation: 1,
      lastCheckAt: Date.now(),
      lastSuccessAt: Date.now(),
      errorCategory: null,
      guidance: null,
      capabilities: ["t3.project.read"],
      catalogObservedAt: Date.now(),
    }));
    return {
      grant,
      args: {
        ownerGrant: { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision },
        requestId: "EGA-TEST:req-1",
        provider: "t3-mcp",
        issueKey: "EGA-TEST",
        projectId: "project-placeholder",
        message: "No external dispatch is expected from this test.",
        runtimeMode: "approval-required",
      },
    };
  }

  it("stops a revoked owner's queued background dispatch before any network call", async () => {
    const t = convexTest(schema, modules);
    const { args } = await prepareDispatch(t);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(t.action(internal.dispatch.dispatchIssue, args)).rejects.toThrow(/unauthorized/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops work queued under a superseded owner grant revision", async () => {
    const t = convexTest(schema, modules);
    const { args } = await prepareDispatch(t);
    await t.mutation(internal.auth.grantOwner, {
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(t.action(internal.dispatch.dispatchIssue, args)).rejects.toThrow(/unauthorized/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revalidates before MCP initialization, after connect, and immediately before launch", async () => {
    const order: string[] = [];
    mcp.connect.mockImplementation(async () => { order.push("connected"); });
    mcp.callTool.mockImplementation(async () => {
      order.push("launched");
      return { content: [{ text: "ok" }] };
    });
    mcp.close.mockResolvedValue(undefined);

    await callTool("https://example.invalid/mcp", "test-token", "t3_thread_launch", {}, {
      beforeConnect: async () => { order.push("grant-checked"); },
      beforeCall: async () => { order.push("grant-checked"); },
    });

    // L-1: the grant is rechecked BEFORE the transport initializes (the bearer
    // token is transmitted during initialization), after connect, and before
    // the tool call.
    expect(order).toEqual(["grant-checked", "connected", "grant-checked", "launched"]);
  });

  it("reduces upstream error bodies to a fixed safe category", async () => {
    const secret = "alphabeta";
    mcp.connect.mockRejectedValue(new Error(`upstream token=${secret} 401 rejected`));
    const result = await callTool("https://example.invalid/mcp", "test-token", "t3_thread_list", {});
    expect(result).toEqual({ ok: false, text: "T3 MCP authentication rejected", authFailure: true });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not pause MCP credentials when owner authorization expires during connect", async () => {
    const t = convexTest(schema, modules);
    const { args } = await prepareDispatch(t);
    process.env.T3_MCP_URL_ISOLATED = "https://mcp.example.invalid";
    process.env.T3_MCP_TOKEN_ISOLATED = "test-token-placeholder";
    mcp.connect.mockImplementation(async () => {
      await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    });
    mcp.close.mockResolvedValue(undefined);

    await expect(t.action(internal.dispatch.dispatchIssue, args)).rejects.toThrow(/owner authorization changed/i);
    expect(mcp.callTool).not.toHaveBeenCalled();
    await expect(t.query(internal.credentials.canDispatch, { provider: "t3-mcp" }))
      .resolves.toMatchObject({ allowed: true, status: "active" });
  });

  it("denies standalone reconciliation after the captured owner grant is revoked", async () => {
    const t = convexTest(schema, modules);
    const { grant } = await prepareDispatch(t);
    const prepared = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-TEST",
      targetProjectId: "project-placeholder",
      attemptId: "EGA-TEST:reconcile-placeholder",
      payloadHash: "a".repeat(64),
    });
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });

    await expect(t.action(internal.dispatch.reconcileAttempt, {
      attemptId: prepared.attemptId,
      projectId: "project-placeholder",
      ownerGrant: { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision },
    })).rejects.toThrow(/unauthorized/);
    expect(mcp.connect).not.toHaveBeenCalled();
  });

  it("rechecks reconciliation authority after connect and before updating its attempt", async () => {
    const t = convexTest(schema, modules);
    const { grant } = await prepareDispatch(t);
    const prepared = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: "EGA-TEST",
      targetProjectId: "project-placeholder",
      attemptId: "EGA-TEST:reconcile-handshake",
      payloadHash: "a".repeat(64),
    });
    process.env.T3_MCP_URL_ISOLATED = "https://mcp.example.invalid";
    process.env.T3_MCP_TOKEN_ISOLATED = "test-token-placeholder";
    mcp.connect.mockImplementation(async () => {
      await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    });
    mcp.close.mockResolvedValue(undefined);

    await expect(t.action(internal.dispatch.reconcileAttempt, {
      attemptId: prepared.attemptId,
      projectId: "project-placeholder",
      ownerGrant: { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision },
    })).rejects.toThrow(/owner authorization changed/i);
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});
