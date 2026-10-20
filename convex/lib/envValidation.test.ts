/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnv, assertEnv } from "./envValidation";

const VALID_KEY = Buffer.from("a".repeat(32)).toString("base64");

function baseEnv(): Record<string, string> {
  return {
    NEXT_PUBLIC_CONVEX_URL: "https://dev.example.convex.cloud",
    HELM_APP_URL: "https://helm-dev.example.vercel.app",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abcdefghijklmnopqrstuvwxyz",
    CLERK_FRONTEND_API_URL: "https://clerk-dev.example.com",
    HELM_OWNER_SUBJECT: "user_2abc",
    LINEAR_CLIENT_ID: "linear-client-id",
    T3_OAUTH_ENCRYPTION_KEY_VERSION: "v1",
    T3_OAUTH_ENCRYPTION_KEY_V1: VALID_KEY,
    LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: "v1",
    LINEAR_OAUTH_ENCRYPTION_KEY_V1: VALID_KEY,
    T3_MCP_URL: "https://t3-privileged.example/mcp",
    T3_MCP_TOKEN: "privileged-token-placeholder",
    T3_MCP_URL_ISOLATED: "https://t3-isolated.example/mcp",
    T3_MCP_TOKEN_ISOLATED: "isolated-token-placeholder",
    T3_PROJECT_ID_ISOLATED: "t3-project-placeholder",
    LINEAR_API_KEY: "lin_api_placeholder",
    LINEAR_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
  };
}

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of Object.keys(baseEnv())) saved[key] = process.env[key];
  // clear managed keys
  for (const key of Object.keys(baseEnv())) delete process.env[key];
  for (const [k, v] of Object.entries(baseEnv())) process.env[k] = v;
});

afterEach(() => {
  for (const key of Object.keys(baseEnv())) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("envValidation: valid environment", () => {
  it("reports ok when all required variables are present and well-formed", () => {
    const result = validateEnv(process.env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a legacy T3 key fallback for v1", () => {
    delete process.env.T3_OAUTH_ENCRYPTION_KEY_V1;
    process.env.T3_OAUTH_ENCRYPTION_KEY = VALID_KEY;
    const result = validateEnv(process.env);
    expect(result.ok).toBe(true);
  });

  it("accepts optional variables when absent", () => {
    const result = validateEnv(process.env);
    expect(result.ok).toBe(true);
  });
});

describe("envValidation: missing required", () => {
  it("reports each missing variable as a distinct issue", () => {
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.T3_MCP_TOKEN_ISOLATED;
    const result = validateEnv(process.env);
    expect(result.ok).toBe(false);
    const names = result.issues.map((i) => i.variable);
    expect(names).toContain("LINEAR_CLIENT_ID");
    expect(names).toContain("T3_MCP_TOKEN_ISOLATED");
    expect(result.issues).toHaveLength(2);
  });

  it("never includes a secret value in any message", () => {
    const secret = "SUPER_SECRET_VALUE_123";
    process.env.T3_MCP_TOKEN = secret;
    const result = validateEnv(process.env);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });
});

describe("envValidation: malformed values", () => {
  it("rejects a non-URL NEXT_PUBLIC_CONVEX_URL", () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "not a url";
    const result = validateEnv(process.env);
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.variable === "NEXT_PUBLIC_CONVEX_URL")?.problem).toBe("malformed");
  });

  it("rejects an http HELM_APP_URL (must be https)", () => {
    process.env.HELM_APP_URL = "http://helm-dev.example.vercel.app";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "HELM_APP_URL")?.problem).toBe("malformed");
  });

  it("rejects HELM_APP_URL with embedded userinfo", () => {
    process.env.HELM_APP_URL = "https://user:pass@helm-dev.example.vercel.app";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "HELM_APP_URL")?.problem).toBe("malformed");
  });

  it("rejects an invalid isolated endpoint", () => {
    process.env.T3_MCP_URL_ISOLATED = "http://isolated.example/mcp";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "T3_MCP_URL_ISOLATED")?.problem).toBe("malformed");
  });

  it("rejects a 16-byte encryption key", () => {
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = Buffer.from("a".repeat(16)).toString("base64");
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "T3_OAUTH_ENCRYPTION_KEY_V1")?.problem).toBe("malformed");
  });

  it("rejects a bad version format", () => {
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "version1";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "T3_OAUTH_ENCRYPTION_KEY_VERSION")?.problem).toBe("malformed");
  });

  it("rejects an invalid Clerk subject (whitespace)", () => {
    process.env.HELM_OWNER_SUBJECT = "user a";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "HELM_OWNER_SUBJECT")?.problem).toBe("malformed");
  });
});

describe("envValidation: assertEnv", () => {
  it("throws when invalid", () => {
    delete process.env.LINEAR_CLIENT_ID;
    expect(() => assertEnv(process.env)).toThrow(/LINEAR_CLIENT_ID/);
  });

  it("does not throw when valid", () => {
    expect(() => assertEnv(process.env)).not.toThrow();
  });
});

describe("envValidation: optional variables", () => {
  it("reports malformed optional NEXT_PUBLIC_CONVEX_SITE_URL", () => {
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "not a url";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "NEXT_PUBLIC_CONVEX_SITE_URL")).toBeDefined();
  });

  it("reports malformed fixtures flag", () => {
    process.env.NEXT_PUBLIC_HELM_T3_FIXTURES = "yes";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "NEXT_PUBLIC_HELM_T3_FIXTURES")).toBeDefined();
  });
});

describe("envValidation: placeholder detection", () => {
  it("treats a placeholder URL as missing", () => {
    process.env.T3_MCP_URL = "https://YOUR_PUBLIC_T3_MCP_ENDPOINT/mcp";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "T3_MCP_URL")?.problem).toBe("missing");
  });
});