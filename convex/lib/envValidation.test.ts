/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnv } from "./envValidation";

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
    T3_NATIVE_WRITE_ENDPOINT: "https://t3-isolated.t3coderelay.com/mcp",
    T3_NATIVE_WRITE_ENVIRONMENTS: "env-isolated",
    LINEAR_API_KEY: "lin_api_placeholder",
    LINEAR_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://dev.example.convex.site",
    NEXT_PUBLIC_HELM_T3_FIXTURES: "false",
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

  it("never includes a secret value in any issue message", () => {
    const secret = "SUPER_SECRET_VALUE_123";
    // Drive a path that actually produces an issue for the sentinel variable.
    process.env.CLERK_FRONTEND_API_URL = secret;
    const result = validateEnv(process.env);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.variable === "CLERK_FRONTEND_API_URL");
    expect(issue).toBeDefined();
    // Inspect issues explicitly, not a serialized Array subclass.
    for (const item of result.issues) {
      expect(item.message).not.toContain(secret);
      expect(item.variable).not.toContain(secret);
    }
    expect(result.errors.every((e) => !e.includes(secret))).toBe(true);
  });

  it("does not leak a sentinel across every validated variable", () => {
    const sentinel = "LEAK_SENTINEL_VALUE_42";
    for (const key of Object.keys(baseEnv())) process.env[key] = sentinel;
    // Keep version selectors valid so the encryption-key branch is actually reached.
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = sentinel;
    process.env.T3_OAUTH_ENCRYPTION_KEY = sentinel;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = sentinel;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY = sentinel;
    process.env.LINEAR_CLIENT_SECRET = sentinel;
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL = sentinel;
    process.env.NEXT_PUBLIC_HELM_T3_FIXTURES = sentinel;
    const result = validateEnv(process.env);
    for (const issue of result.issues) {
      expect(issue.message).not.toContain(sentinel);
      expect(issue.variable).not.toContain(sentinel);
    }
    for (const error of result.errors) {
      expect(error).not.toContain(sentinel);
    }
  });

  it("does not leak a sentinel in the version-malformed branch", () => {
    const sentinel = "LEAK_SENTINEL_VALUE_42";
    // Keep keys valid so the version-malformed branch is the one exercised.
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = sentinel;
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = VALID_KEY;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = sentinel;
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = VALID_KEY;
    const result = validateEnv(process.env);
    const versionIssues = result.issues.filter((i) =>
      i.variable === "T3_OAUTH_ENCRYPTION_KEY_VERSION" ||
      i.variable === "LINEAR_OAUTH_ENCRYPTION_KEY_VERSION",
    );
    expect(versionIssues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.message).not.toContain(sentinel);
    }
    for (const error of result.errors) {
      expect(error).not.toContain(sentinel);
    }
  });

  it("does not leak a sentinel in the not_observable branch", () => {
    const sentinel = "LEAK_SENTINEL_VALUE_42";
    const env = { ...baseEnv(), NEXT_PUBLIC_CONVEX_URL: sentinel };
    const result = validateEnv(env as Record<string, string | undefined>, "convex");
    const issue = result.issues.find((i) => i.variable === "NEXT_PUBLIC_CONVEX_URL");
    expect(issue?.problem).toBe("not_observable_from_convex");
    expect(issue?.message).not.toContain(sentinel);
    for (const item of result.issues) {
      expect(item.message).not.toContain(sentinel);
    }
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

  it("treats an empty versioned key as malformed even with a valid legacy key", () => {
    process.env.T3_OAUTH_ENCRYPTION_KEY_V1 = "";
    process.env.T3_OAUTH_ENCRYPTION_KEY = VALID_KEY;
    const result = validateEnv(process.env);
    const issue = result.issues.find((i) => i.variable === "T3_OAUTH_ENCRYPTION_KEY_V1");
    expect(issue?.problem).toBe("malformed");
  });

  it("reports each variable at most once", () => {
    process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION = "version1";
    const result = validateEnv(process.env);
    const names = result.issues.map((i) => i.variable);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("rejects an invalid Clerk subject (whitespace)", () => {
    process.env.HELM_OWNER_SUBJECT = "user a";
    const result = validateEnv(process.env);
    expect(result.issues.find((i) => i.variable === "HELM_OWNER_SUBJECT")?.problem).toBe("malformed");
  });
});

describe("envValidation: failure reporting", () => {
  it("reports invalid when a required variable is missing", () => {
    delete process.env.LINEAR_CLIENT_ID;
    const result = validateEnv(process.env);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.variable === "LINEAR_CLIENT_ID")).toBe(true);
    expect(result.issues.find((i) => i.variable === "LINEAR_CLIENT_ID")?.message).toMatch(/LINEAR_CLIENT_ID/);
  });

  it("reports ok when valid", () => {
    const result = validateEnv(process.env);
    expect(result.ok).toBe(true);
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