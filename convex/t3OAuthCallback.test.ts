/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * The T3 OAuth callback action, exercised end to end through the real action.
 *
 * The regression this file covers: the callback used to report a provider
 * error BEFORE it recorded the attempt, so a failure while recording the
 * attempt produced a SECOND diagnostic labelled with the wrong stage. A failed
 * callback must emit exactly ONE sanitized diagnostic, classified at the stage
 * where the failure really happened.
 *
 * There is NO live T3, no socket and no credential here: the identity is a
 * local mock, the token endpoint and the MCP client are mocked in-process, and
 * every secret on the wire is a placeholder.
 */
const transport = vi.hoisted(() => ({ request: vi.fn(), callTool: vi.fn() }));
vi.mock("node:https", () => ({ request: transport.request }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ family: 4, address: "93.184.216.34" }],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() { return undefined; }
    async callTool(args: { name: string; arguments?: unknown }) { return transport.callTool(args); }
    async listTools() { return { tools: [] }; }
    async close() { return undefined; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const OWNER_IDENTITY = {
  tokenIdentifier: `${OWNER_ISSUER}|${OWNER_SUBJECT}`,
  subject: OWNER_SUBJECT,
  issuer: OWNER_ISSUER,
};
const T3_ISSUER = "https://studio.t3coderelay.com";
const ENDPOINT = "https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp";
const REDIRECT = "https://helm.example/api/t3/callback";
const CLIENT_ID = "helm-public-client";
/** The callback only accepts a 43-character base64url state. */
const STATE = "s".repeat(43);
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The same envelope the backend writes, so the callback can decrypt it. */
function seal(value: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "base64"), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

describe("T3 OAuth callback action", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    savedKey = process.env.T3_OAUTH_ENCRYPTION_KEY;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    process.env.T3_OAUTH_ENCRYPTION_KEY = ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
    if (savedKey === undefined) delete process.env.T3_OAUTH_ENCRYPTION_KEY;
    else process.env.T3_OAUTH_ENCRYPTION_KEY = savedKey;
    vi.restoreAllMocks();
  });

  async function granted() {
    const t = convexTest(schema, modules).withIdentity(OWNER_IDENTITY);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  function attemptId(access: "read-only" | "operate") {
    return `attempt-${access}-${digest(STATE)}`;
  }

  function beginAttempt(t: Harness, access: "read-only" | "operate" = "operate") {
    return t.mutation(internal.t3ConnectionsStore.createAttempt, {
      ...owner,
      attemptId: attemptId(access),
      endpoint: ENDPOINT,
      issuer: T3_ISSUER,
      resource: ENDPOINT,
      authorizationEndpoint: `${T3_ISSUER}/oauth/mcp/authorize`,
      tokenEndpoint: `${T3_ISSUER}/oauth/mcp/token`,
      registrationEndpoint: `${T3_ISSUER}/oauth/mcp/register`,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      stateHash: digest(STATE),
      verifierCiphertext: seal("verifier-placeholder", `pkce:${OWNER_ISSUER}:${OWNER_SUBJECT}:${attemptId(access)}`),
      connectionId: null,
      expectedConnectionCredentialVersion: null,
      access,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });
  }

  /** The token endpoint answers with this body. */
  function tokenEndpoint(body: unknown, status = 200) {
    transport.request.mockImplementation((_url: unknown, _options: unknown, callback: (res: unknown) => void) => {
      const request = {
        on: () => request,
        write: () => undefined,
        destroy: () => undefined,
        end: () => {
          const res = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
          Object.assign(res, { statusCode: status, headers: { "content-type": "application/json" } });
          setTimeout(() => callback(res), 0);
        },
      };
      return request;
    });
  }

  /** The environment read answers with this payload. */
  function environmentRead(payload: unknown = {
    environmentId: "env-openclaw", label: "openclaw", serverVersion: "0.0.46", platform: "linux/arm64",
  }) {
    transport.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  }

  function attempts(t: Harness) {
    return t.run(async (ctx) => await ctx.db.query("t3AuthAttempts").collect());
  }

  function connections(t: Harness) {
    return t.run(async (ctx) => await ctx.db.query("t3Connections").collect());
  }

  it("records a provider error as failed and reports it exactly once", async () => {
    const t = await granted();
    await beginAttempt(t);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await t.action(api.t3OAuth.callback, { state: STATE, error: "server_error", issuer: T3_ISSUER });
    expect(result).toEqual({ connectionId: null, status: "failed" });
    // The regression: a provider error used to be reported before the attempt
    // was recorded, so a failure while recording it produced a second event.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "provider_response", category: "provider_error", access: "operate",
    });
    expect((await attempts(t))[0]?.status).toBe("failed");
    expect(await connections(t)).toHaveLength(0);
  });

  it("keeps an owner denial as a denial and reports no failure", async () => {
    const t = await granted();
    await beginAttempt(t);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await t.action(api.t3OAuth.callback, { state: STATE, error: "access_denied", issuer: T3_ISSUER });
    expect(result).toEqual({ connectionId: null, status: "denied" });
    expect(spy).not.toHaveBeenCalled();
    expect((await attempts(t))[0]?.status).toBe("denied");
  });

  it("keeps an expired consent as expired and reports no failure", async () => {
    const t = await granted();
    await beginAttempt(t);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await t.action(api.t3OAuth.callback, { state: STATE, error: "consent_expired", issuer: T3_ISSUER });
    expect(result).toEqual({ connectionId: null, status: "expired" });
    expect(spy).not.toHaveBeenCalled();
    expect((await attempts(t))[0]?.status).toBe("expired");
  });

  it("reports one issuer-mismatch diagnostic and saves nothing", async () => {
    const t = await granted();
    await beginAttempt(t);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, error: "server_error", issuer: "https://other-issuer.example" }),
    ).rejects.toThrow(/remains unchanged/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "issuer_validation", category: "issuer_mismatch", access: "operate",
    });
    expect(await connections(t)).toHaveLength(0);
  });

  it("reports one scope-mismatch diagnostic after a successful token exchange", async () => {
    const t = await granted();
    await beginAttempt(t);
    tokenEndpoint({
      access_token: "t3-placeholder-token",
      token_type: "Bearer",
      expires_in: 3600,
      // The consent covered the read scope only, while an operate consent was
      // requested. The grant must not be widened or stored.
      scope: "orchestration:read",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, code: "code-placeholder", issuer: T3_ISSUER }),
    ).rejects.toThrow(/remains unchanged/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "scope_validation", category: "scope_mismatch", access: "operate",
    });
    // Nothing was persisted: the grant is refused before the connection exists.
    expect(await connections(t)).toHaveLength(0);
    expect((await attempts(t))[0]?.status).toBe("failed");
  });

  it("reports one environment-verification diagnostic and saves nothing", async () => {
    const t = await granted();
    await beginAttempt(t);
    tokenEndpoint({
      access_token: "t3-placeholder-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "orchestration:read orchestration:operate",
    });
    transport.callTool.mockResolvedValue({ isError: true, content: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, code: "code-placeholder", issuer: T3_ISSUER }),
    ).rejects.toThrow(/remains unchanged/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "environment_verification", category: "environment_verification_failed", access: "operate",
    });
    expect(await connections(t)).toHaveLength(0);
  });

  it("never leaks an upstream rejection body into the diagnostic", async () => {
    const t = await granted();
    await beginAttempt(t);
    tokenEndpoint({ error: "invalid_grant", error_description: "Bearer SECRET_TOKEN code=SECRET_CODE" }, 400);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, code: "code-placeholder", issuer: T3_ISSUER }),
    ).rejects.toThrow(/remains unchanged/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "token_exchange", category: "token_endpoint_rejected", access: "operate",
    });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toMatch(/SECRET_TOKEN|SECRET_CODE|Bearer|invalid_grant/u);
  });

  it("reports one connection-save diagnostic and stores nothing", async () => {
    const t = await granted();
    await beginAttempt(t);
    tokenEndpoint({
      access_token: "t3-placeholder-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "orchestration:read orchestration:operate",
    });
    environmentRead();
    // The owner configuration changes between the consent and the save, so
    // the save is refused. The diagnostic names the stage that failed, and
    // no connection is written.
    const original = transport.request.getMockImplementation();
    transport.request.mockImplementation((...args: unknown[]) => {
      process.env.HELM_OWNER_SUBJECT = "owner-subject-changed";
      return (original as (...call: unknown[]) => unknown)(...args);
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, code: "code-placeholder", issuer: T3_ISSUER }),
    ).rejects.toThrow(/remains unchanged/u);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("t3_oauth_callback_failure", {
      stage: "connection_save", category: "connection_save_failed", access: "operate",
    });
    expect(await connections(t)).toHaveLength(0);
  });

  it("saves the connection and reports no failure when the consent is honoured", async () => {
    const t = await granted();
    await beginAttempt(t);
    tokenEndpoint({
      access_token: "t3-placeholder-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "orchestration:read orchestration:operate",
    });
    environmentRead();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await t.action(api.t3OAuth.callback, { state: STATE, code: "code-placeholder", issuer: T3_ISSUER });
    expect(result.status).toBe("connected");
    expect(spy).not.toHaveBeenCalled();
    const saved = await connections(t);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ access: "operate", status: "connected", environmentId: "env-openclaw" });
    expect((await attempts(t))[0]?.status).toBe("connected");
  });

  it("refuses a callback whose state and code do not agree", async () => {
    const t = await granted();
    await beginAttempt(t);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, code: "abc", error: "server_error", issuer: T3_ISSUER }),
    ).rejects.toThrow(/invalid/iu);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a callback whose state was never issued", async () => {
    const t = await granted();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      t.action(api.t3OAuth.callback, { state: STATE, error: "server_error", issuer: T3_ISSUER }),
    ).rejects.toThrow(/invalid or expired/iu);
    expect(spy).not.toHaveBeenCalled();
  });
});
