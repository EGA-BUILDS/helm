"use node";

/**
 * Pure, side-effect-free validation of the environment variables Helm actually
 * reads (see `doc/v0.2/EGA-770-hosted-dev-prep.md` for the derived table).
 *
 * This is the ONE configuration-validation layer for the app: it does not
 * replace the runtime readers in `convex/lib/linearHelpers.ts`,
 * `convex/lib/dispatchConfig.ts`, `convex/t3OAuth.ts` or `src/lib/t3Backend.ts`,
 * it only reports, ahead of time and without revealing any value, whether those
 * readers will succeed. Every failure is reported independently so an operator
 * can fix the deployment in one pass.
 *
 * The module never reads, logs, returns or echoes a secret value: issues carry
 * the variable NAME and a problem description only.
 */

import { isValidIsolatedEndpoint } from "./dispatchConfigValidation";

export type EnvScope = "next" | "convex" | "both";

export interface EnvValidationIssue {
  /** Environment variable name (never its value). */
  variable: string;
  /** Where the variable is consumed. */
  scope: EnvScope;
  /** Short machine-readable problem code. */
  problem: "missing" | "invalid" | "malformed";
  /** Actionable, human-readable message naming the variable and the fix. */
  message: string;
}

export interface EnvValidationResult extends Array<string> {
  ok: boolean;
  issues: EnvValidationIssue[];
  errors: string[];
}

type Env = Record<string, string | undefined>;

const PLACEHOLDERS = new Set([
  "https://YOUR_CONVEX_DEPLOYMENT_URL",
  "https://YOUR_CONVEX_SITE_URL",
  "https://YOUR_PUBLIC_T3_MCP_ENDPOINT/mcp",
  "https://YOUR_ISOLATED_T3_MCP_ENDPOINT/mcp",
]);

function raw(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function isPresent(value: string): boolean {
  return value.length > 0 && !PLACEHOLDERS.has(value);
}

function addIssue(
  issues: EnvValidationIssue[],
  variable: string,
  scope: EnvScope,
  problem: EnvValidationIssue["problem"],
  message: string,
): void {
  issues.push({ variable, scope, problem, message });
}

function checkRequiredString(
  issues: EnvValidationIssue[],
  env: Env,
  variable: string,
  scope: EnvScope,
  guidance: string,
  extra?: (value: string) => string | null,
): void {
  const value = raw(env, variable);
  if (!isPresent(value)) {
    addIssue(issues, variable, scope, "missing", `${variable} is required but is not set. ${guidance}`);
    return;
  }
  if (extra) {
    const problem = extra(value);
    if (problem) {
      addIssue(issues, variable, scope, "malformed", `${variable} is malformed: ${problem}. ${guidance}`);
    }
  }
}

function checkOptionalString(
  issues: EnvValidationIssue[],
  env: Env,
  variable: string,
  scope: EnvScope,
  extra?: (value: string) => string | null,
): void {
  const value = raw(env, variable);
  if (!isPresent(value)) return;
  if (extra) {
    const problem = extra(value);
    if (problem) {
      addIssue(issues, variable, scope, "malformed", `${variable} is malformed: ${problem}.`);
    }
  }
}

function checkUrl(
  value: string,
  requireHttps: boolean,
  allowUserinfo: boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "expected an absolute URL";
  }
  if (!parsed.hostname) return "expected an absolute URL with a host";
  if (requireHttps && parsed.protocol !== "https:") {
    return "expected an https:// URL";
  }
  if (!allowUserinfo && (parsed.username || parsed.password)) {
    return "must not contain embedded userinfo";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "expected an http(s) URL";
  }
  return null;
}

function checkVersionFormat(value: string): string | null {
  return /^v[1-9][0-9]{0,2}$/u.test(value) ? null : "expected a version like v1, v2, ...";
}

function base64ByteLength(value: string): number | null {
  try {
    if (!/^[A-Za-z0-9+/\-_]+={0,2}$/u.test(value)) return null;
    // Accept both standard and url-safe base64; normalise.
    const normalised = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const buf = Buffer.from(normalised, "base64");
    // Buffer is lenient; re-encode to detect garbage.
    if (buf.toString("base64").replace(/=+$/u, "") !== normalised.replace(/=+$/u, "")) {
      return null;
    }
    return buf.length;
  } catch {
    return null;
  }
}

function checkEncryptionKey(
  issues: EnvValidationIssue[],
  env: Env,
  prefix: "T3_OAUTH" | "LINEAR_OAUTH",
  scope: EnvScope,
): void {
  const versionVar = `${prefix}_ENCRYPTION_KEY_VERSION`;
  const guidance =
    "Configure a retained 32-byte AES key, base64-encoded (see .env.example).";

  const versionRaw = raw(env, versionVar);
  const version = versionRaw || "v1";
  if (versionRaw) {
    const problem = checkVersionFormat(version);
    if (problem) {
      addIssue(issues, versionVar, scope, "malformed", `${versionVar} is malformed: ${problem}. ${guidance}`);
      return;
    }
  }

  const specificVar = `${prefix}_ENCRYPTION_KEY_${version.toUpperCase()}`;
  const legacyVar = `${prefix}_ENCRYPTION_KEY`;
  let encoded = raw(env, specificVar);
  let sourceVar = specificVar;
  if (!encoded && version === "v1") {
    encoded = raw(env, legacyVar);
    sourceVar = legacyVar;
  }

  if (!isPresent(encoded)) {
    addIssue(
      issues,
      sourceVar,
      scope,
      "missing",
      `${sourceVar} is required but is not set. ${guidance}`,
    );
    return;
  }

  const bytes = base64ByteLength(encoded);
  if (bytes === null || bytes !== 32) {
    addIssue(
      issues,
      sourceVar,
      scope,
      "malformed",
      `${sourceVar} is malformed: expected a base64 encoding of exactly 32 bytes. ${guidance}`,
    );
  }
}

export function validateEnv(env: Env = process.env): EnvValidationResult {
  const issues: EnvValidationIssue[] = [];

  // --- Next.js / Vercel side ---
  checkRequiredString(issues, env, "NEXT_PUBLIC_CONVEX_URL", "next",
    "Set it to the Convex deployment URL the browser subscribes to (https://...convex.cloud).",
    (v) => checkUrl(v, false, false));

  checkRequiredString(issues, env, "HELM_APP_URL", "both",
    "Set it to this deployment's origin in BOTH runtimes; mutating routes fail closed on mismatch.",
    (v) => checkUrl(v, true, false));

  checkRequiredString(issues, env, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "next",
    "Set it to the Clerk publishable key for this instance (pk_test_... / pk_live_...).",
    (v) => (v.length >= 10 ? null : "expected a Clerk publishable key"));

  // --- Convex side ---
  checkRequiredString(issues, env, "CLERK_FRONTEND_API_URL", "convex",
    "Set it to the Clerk Frontend API (JWT issuer) URL used by convex/auth.config.ts.",
    (v) => checkUrl(v, true, false));

  checkRequiredString(issues, env, "HELM_OWNER_SUBJECT", "convex",
    "Set it to the single immutable owner subject (user_...) enforced server-side.",
    (v) => (/^\S+$/u.test(v) && v.length <= 256 ? null : "expected a non-empty subject without whitespace"));

  checkRequiredString(issues, env, "LINEAR_CLIENT_ID", "convex",
    "Create a Linear OAuth application and set its client id (redirect URI <HELM_APP_URL>/api/linear/callback).",
    (v) => (v.length <= 512 ? null : "expected at most 512 characters"));

  checkOptionalString(issues, env, "LINEAR_CLIENT_SECRET", "convex",
    (v) => (v.length <= 2048 ? null : "expected at most 2048 characters"));

  checkEncryptionKey(issues, env, "T3_OAUTH", "convex");
  checkEncryptionKey(issues, env, "LINEAR_OAUTH", "convex");

  checkRequiredString(issues, env, "T3_MCP_URL", "convex",
    "Set it to the PRIVILEGED (discovery-only) T3 MCP HTTPS endpoint reachable from Convex.",
    (v) => checkUrl(v, true, false));

  checkRequiredString(issues, env, "T3_MCP_TOKEN", "convex",
    "Issue it server-side with `t3 auth session issue`; never log or expose it.",
    (v) => (v.length >= 1 ? null : "expected a non-empty bearer token"));

  // Isolated dispatch: reuse the exact shared policy.
  checkRequiredString(issues, env, "T3_MCP_URL_ISOLATED", "convex",
    "Set it to the ISOLATED T3 MCP HTTPS endpoint dispatch is allowed to launch on.",
    (v) => (isValidIsolatedEndpoint(v) ? null : "expected a valid absolute https URL without embedded userinfo"));

  checkRequiredString(issues, env, "T3_MCP_TOKEN_ISOLATED", "convex",
    "Set it to the bearer credential for the ISOLATED T3 instance; dispatch reads only this token.",
    (v) => (v.length >= 1 ? null : "expected a non-empty bearer token"));

  checkRequiredString(issues, env, "T3_PROJECT_ID_ISOLATED", "convex",
    "Set it to the trusted isolated T3 project binding; missing disables dispatch.",
    (v) => (v.length >= 1 ? null : "expected a non-empty project id"));

  checkRequiredString(issues, env, "LINEAR_API_KEY", "convex",
    "Set it to a read-scoped Linear personal API key (server-side only).",
    (v) => (v.length >= 1 ? null : "expected a non-empty API key"));

  checkRequiredString(issues, env, "LINEAR_PROJECT_ID", "convex",
    "Set it to the target Linear project UUID.",
    (v) => (v.length >= 1 ? null : "expected a non-empty project id"));

  // Optional variables: validate shape only when present.
  checkOptionalString(issues, env, "NEXT_PUBLIC_CONVEX_SITE_URL", "next",
    (v) => checkUrl(v, false, false));
  checkOptionalString(issues, env, "T3_OAUTH_ENCRYPTION_KEY_VERSION", "convex",
    (v) => checkVersionFormat(v));
  checkOptionalString(issues, env, "LINEAR_OAUTH_ENCRYPTION_KEY_VERSION", "convex",
    (v) => checkVersionFormat(v));
  checkOptionalString(issues, env, "NEXT_PUBLIC_HELM_T3_FIXTURES", "next",
    (v) => (v === "true" || v === "false" ? null : "expected \"true\" or \"false\""));

  const messages = issues.map((i) => i.message);
  const result = messages as EnvValidationResult;
  result.ok = issues.length === 0;
  result.issues = issues;
  result.errors = messages;
  return result;
}

export function assertEnv(env: Env = process.env): void {
  const result = validateEnv(env);
  if (!result.ok) {
    throw new Error(
      `Environment validation failed (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}):\n` +
        result.issues.map((i) => `- ${i.message}`).join("\n"),
    );
  }
}

export const validateEnvironment = validateEnv;
export const checkEnv = validateEnv;
export const requireEnv = assertEnv;
export const validateEnvironmentConfiguration = validateEnv;
export const assertEnvironment = assertEnv;
export const requireEnvironment = assertEnv;
export const checkEnvironment = validateEnv;