/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * The T3 OAuth start action, exercised through the real action with discovery,
 * registration and the token-free authorization URL. There is no live T3 and no
 * credential: every response is an in-process placeholder.
 *
 * The regression this file covers: Helm must request exactly the scopes it can
 * validate. T3 ignores the requested scope, but the request still has to be
 * correct so a compatible consent can be recognized and an incompatible one
 * rejected for the right reason.
 */
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: transport.request }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ family: 4, address: "93.184.216.34" }],
}));

const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const OWNER_IDENTITY = {
  tokenIdentifier: `${OWNER_ISSUER}|${OWNER_SUBJECT}`,
  subject: OWNER_SUBJECT,
  issuer: OWNER_ISSUER,
};
const ENDPOINT = "https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp";
// T3 requires the OAuth issuer to share the MCP endpoint's origin.
const T3_ISSUER = new URL(ENDPOINT).origin;
const CLIENT_ID = "helm-public-client";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

function jsonResponse(body: unknown) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(stream, { statusCode: 200, headers: { "content-type": "application/json" } });
  return stream;
}

describe("T3 OAuth start action", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;
  let savedKey: string | undefined;
  let savedAppUrl: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    savedKey = process.env.T3_OAUTH_ENCRYPTION_KEY;
    savedAppUrl = process.env.HELM_APP_URL;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    process.env.T3_OAUTH_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.HELM_APP_URL = "https://helm.example";

    transport.request.mockImplementation((url: URL, _options: unknown, callback: (res: unknown) => void) => {
      const path = new URL(String(url)).pathname;
      const request = {
        on: () => request,
        write: () => undefined,
        destroy: () => undefined,
        end: () => {
          const body = path === "/.well-known/oauth-protected-resource/mcp"
            ? { resource: ENDPOINT, authorization_servers: [T3_ISSUER] }
            : path === "/.well-known/oauth-authorization-server"
              ? {
                  issuer: T3_ISSUER,
                  authorization_endpoint: `${T3_ISSUER}/oauth/mcp/authorize`,
                  token_endpoint: `${T3_ISSUER}/oauth/mcp/token`,
                  registration_endpoint: `${T3_ISSUER}/oauth/mcp/register`,
                  code_challenge_methods_supported: ["S256"],
                  grant_types_supported: ["authorization_code"],
                }
              : { client_id: CLIENT_ID };
          setTimeout(() => callback(jsonResponse(body)), 0);
        },
      };
      return request;
    });
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
    if (savedKey === undefined) delete process.env.T3_OAUTH_ENCRYPTION_KEY;
    else process.env.T3_OAUTH_ENCRYPTION_KEY = savedKey;
    if (savedAppUrl === undefined) delete process.env.HELM_APP_URL;
    else process.env.HELM_APP_URL = savedAppUrl;
    vi.restoreAllMocks();
  });

  async function granted() {
    const t = convexTest(schema, modules).withIdentity(OWNER_IDENTITY);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  function attempts(t: Harness) {
    return t.run(async (ctx) => await ctx.db.query("t3AuthAttempts").collect());
  }

  it("requests exactly orchestration:read for a read-only consent", async () => {
    const t = await granted();
    const result = await t.action(api.t3OAuth.start, { endpoint: ENDPOINT, access: "read-only" });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("orchestration:read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("resource")).toBe(ENDPOINT);
    expect(url.searchParams.get("redirect_uri")).toBe("https://helm.example/api/t3/callback");
    const rows = await attempts(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ access: "read-only", connectionId: null });
  });

  it("requests exactly the two operate scopes and creates a new connection attempt", async () => {
    const t = await granted();
    const result = await t.action(api.t3OAuth.start, { endpoint: ENDPOINT, access: "operate" });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("orchestration:read orchestration:operate");
    expect(url.searchParams.get("resource")).toBe(ENDPOINT);
    expect(url.searchParams.get("prompt")).toBeNull();
    expect(url.searchParams.get("audience")).toBeNull();
    const rows = await attempts(t);
    expect(rows).toHaveLength(1);
    // A new consent must not target or rewrite the existing read-only row.
    expect(rows[0]).toMatchObject({ access: "operate", connectionId: null });
  });
});
