/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  buildLinearAuthorizeUrl,
  decryptLinearSecret,
  encryptLinearSecret,
  linearAccessPurpose,
  linearCallbackUri,
  linearClientId,
  linearPkceChallenge,
  linearPkcePurpose,
  linearRefreshPurpose,
  linearStateDigest,
  parseLinearGrantedScopes,
  parseLinearWorkspaceIdentity,
  validateLinearCallbackParams,
} from "./lib/linearHelpers";

/**
 * Linear OAuth pure-helper contract: PKCE derivation, scope gating, callback
 * parameter validation, workspace-identity parsing, authenticated encryption
 * with distinct access/refresh purposes, and fail-closed client configuration.
 * No network, no Convex runtime, no live Linear credentials.
 */
describe("Linear OAuth helpers", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
      LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
      LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION,
      LINEAR_OAUTH_ENCRYPTION_KEY_V1: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1,
      LINEAR_OAUTH_ENCRYPTION_KEY: process.env.LINEAR_OAUTH_ENCRYPTION_KEY,
      HELM_APP_URL: process.env.HELM_APP_URL,
    };
    const key = Buffer.from("x".repeat(32)).toString("base64");
    process.env.LINEAR_CLIENT_ID = "test-linear-client-id";
    delete process.env.LINEAR_CLIENT_SECRET;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = key;
    delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY;
    process.env.HELM_APP_URL = "https://helm.example";
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("derives the RFC 7636 S256 challenge for a known verifier", () => {
    // RFC 7636 appendix B test vector (unpadded base64url of the SHA-256).
    expect(linearPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    // Verifier entropy from the action is 32 random bytes base64url-encoded.
    expect(linearPkceChallenge("another-verifier")).toHaveLength(43);
  });

  it("builds the authorize URL with the exact required params", () => {
    const href = buildLinearAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://helm.example/api/linear/callback",
      state: "s".repeat(43),
      challenge: "c".repeat(43),
      scopes: ["read", "write"],
    });
    const url = new URL(href);
    expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://helm.example/api/linear/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read,write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("c".repeat(43));
  });

  it("accepts exactly the minimal read/write scopes and rejects anything broader", () => {
    expect(parseLinearGrantedScopes("read,write")).toEqual(["read", "write"]);
    expect(parseLinearGrantedScopes("read")).toEqual(["read"]);
    expect(parseLinearGrantedScopes("read write")).toEqual(["read", "write"]);
    expect(() => parseLinearGrantedScopes("read,write,admin")).toThrow(/exceed read and write/i);
    expect(() => parseLinearGrantedScopes("admin")).toThrow(/exceed read and write/i);
    expect(() => parseLinearGrantedScopes("")).toThrow(/exceed read and write/i);
    expect(() => parseLinearGrantedScopes(undefined)).toThrow(/exceed read and write/i);
    expect(() => parseLinearGrantedScopes("read,write,".repeat(100))).toThrow(/exceed read and write/i);
  });

  it("validates callback parameters and rejects bad states and code/error shapes", () => {
    const state = "a".repeat(43);
    const code = "linear-code";
    expect(() => validateLinearCallbackParams({ state, code, error: undefined })).not.toThrow();
    expect(() => validateLinearCallbackParams({ state: "short", code, error: undefined })).toThrow(/callback is invalid/i);
    expect(() => validateLinearCallbackParams({ state, code, error: "access_denied" })).toThrow(/callback is invalid/i);
    expect(() => validateLinearCallbackParams({ state, code: undefined, error: undefined })).toThrow(/callback is invalid/i);
    expect(() => validateLinearCallbackParams({ state, code: "", error: undefined })).toThrow(/callback is invalid/i);
    expect(() => validateLinearCallbackParams({ state, code: "x".repeat(4097), error: undefined })).toThrow(/callback is invalid/i);
    expect(() => validateLinearCallbackParams({ state, code: undefined, error: "x".repeat(129) })).toThrow(/callback is invalid/i);
  });

  it("parses workspace identity and rejects GraphQL errors and misshapen payloads", () => {
    expect(parseLinearWorkspaceIdentity({
      data: {
        viewer: { id: "viewer-1", name: "Ada" },
        organization: { id: "org-1", name: "Helm", urlKey: "helm" },
      },
    })).toEqual({
      viewerId: "viewer-1", viewerName: "Ada",
      workspaceId: "org-1", workspaceName: "Helm", workspaceUrlKey: "helm",
    });
    expect(() => parseLinearWorkspaceIdentity({ errors: [{ message: "boom" }] })).toThrow(/unavailable/i);
    expect(() => parseLinearWorkspaceIdentity({ data: null })).toThrow(/unavailable/i);
    expect(() => parseLinearWorkspaceIdentity({
      data: { viewer: { id: "v", name: "n" }, organization: { id: "o", name: "n" } },
    })).toThrow(/unavailable/i);
    expect(() => parseLinearWorkspaceIdentity(null)).toThrow(/unavailable/i);
  });

  it("round-trips encryption and isolates access from refresh purposes", () => {
    const issuer = "https://issuer.example";
    const subject = "owner-subject";
    const workspace = "org-1";
    const accessPurpose = linearAccessPurpose(issuer, subject, workspace);
    const refreshPurpose = linearRefreshPurpose(issuer, subject, workspace);
    expect(accessPurpose).not.toBe(refreshPurpose);
    const accessCiphertext = encryptLinearSecret("access-token-value", accessPurpose);
    const refreshCiphertext = encryptLinearSecret("refresh-token-value", refreshPurpose);
    expect(accessCiphertext).not.toBe(refreshCiphertext);
    expect(decryptLinearSecret(accessCiphertext, accessPurpose)).toBe("access-token-value");
    expect(decryptLinearSecret(refreshCiphertext, refreshPurpose)).toBe("refresh-token-value");
    // Cross-purpose decryption must fail: the two rotating credentials are
    // domain-separated even though they share one key.
    expect(() => decryptLinearSecret(accessCiphertext, refreshPurpose)).toThrow();
    expect(() => decryptLinearSecret(refreshCiphertext, accessPurpose)).toThrow();
    // PKCE material lives under a third, attempt-scoped purpose.
    const pkceCiphertext = encryptLinearSecret("verifier", linearPkcePurpose(issuer, subject, "attempt-1"));
    expect(decryptLinearSecret(pkceCiphertext, linearPkcePurpose(issuer, subject, "attempt-1"))).toBe("verifier");
    expect(() => decryptLinearSecret(pkceCiphertext, accessPurpose)).toThrow();
  });

  it("fails closed when the Linear client id is not configured", () => {
    expect(linearClientId()).toBe("test-linear-client-id");
    delete process.env.LINEAR_CLIENT_ID;
    expect(() => linearClientId()).toThrow(/not configured/i);
    process.env.LINEAR_CLIENT_ID = "";
    expect(() => linearClientId()).toThrow(/not configured/i);
  });

  it("fails closed when the Linear encryption key is absent", () => {
    delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1;
    delete process.env.LINEAR_OAUTH_ENCRYPTION_KEY;
    expect(() => encryptLinearSecret("x", "purpose")).toThrow(/not configured/i);
    expect(linearStateDigest("state")).toHaveLength(64);
  });

  it("builds the callback URI from HELM_APP_URL", () => {
    expect(linearCallbackUri()).toBe("https://helm.example/api/linear/callback");
    delete process.env.HELM_APP_URL;
    expect(() => linearCallbackUri()).toThrow(/not configured/i);
  });

  it("rejects anonymous action calls without an owner grant", async () => {
    const modules = import.meta.glob("./**/*.ts");
    const t = convexTest(schema, modules);
    await expect(t.action(api.linearOAuth.list, {})).rejects.toThrow(/unauthorized/i);
    await expect(t.action(api.linearOAuth.start, {})).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a start whose redirect URI does not match the configured callback", async () => {
    const modules = import.meta.glob("./**/*.ts");
    const t = convexTest(schema, modules);
    const subject = "owner-subject-placeholder";
    const issuer = "https://test-issuer-placeholder.clerk.accounts.dev";
    process.env.HELM_OWNER_SUBJECT = subject;
    process.env.CLERK_FRONTEND_API_URL = issuer;
    await t.mutation(internal.auth.grantOwner, { subject, issuer });
    const authed = t.withIdentity({ subject, issuer });
    await expect(
      authed.action(api.linearOAuth.start, { redirectUri: "https://evil.example/api/linear/callback" }),
    ).rejects.toThrow(/callback URI mismatch/i);
  });
});
