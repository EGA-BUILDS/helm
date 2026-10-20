"use node";

/**
 * Pure, side-effect-free validation of the environment variables Helm reads
 * (see `doc/v0.2/EGA-770-hosted-dev-prep.md` for the derived table).
 *
 * Single configuration-validation layer: it reports, without revealing any
 * value, whether the runtime readers will succeed. Each failure is reported
 * independently.
 *
 * `validateEnv(env, runtime)` is scoped to a runtime:
 *   - "all"   (default): validate every variable.
 *   - "convex": validate convex/both-scope variables; report next-scope
 *     variables as `not_observable_from_convex` (non-failing) because they live
 *     in Vercel and cannot be seen from a Convex deployment.
 *   - "next":   symmetric for the Next/Vercel runtime.
 *
 * The module never reads, logs, returns or echoes a secret value.
 */

import { isValidIsolatedEndpoint } from "./dispatchConfigValidation";

export type EnvScope = "next" | "convex" | "both";
export type EnvRuntime = "all" | "convex" | "next";

export interface EnvValidationIssue {
  variable: string;
  scope: EnvScope;
  problem:
    | "missing"
    | "invalid"
    | "malformed"
    | "not_observable_from_convex"
    | "not_observable_from_next";
  message: string;
}

export interface EnvValidationResult {
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

function trimmed(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function isPresent(value: string): boolean {
  return value.length > 0 && !PLACEHOLDERS.has(value);
}

function notObservableProblem(runtime: EnvRuntime): EnvValidationIssue["problem"] | null {
  if (runtime === "convex") return "not_observable_from_convex";
  if (runtime === "next") return "not_observable_from_next";
  return null;
}

function observable(scope: EnvScope, runtime: EnvRuntime): boolean {
  if (runtime === "all") return true;
  if (runtime === "convex") return scope === "convex" || scope === "both";
  return scope === "next" || scope === "both";
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

function isFailing(problem: EnvValidationIssue["problem"]): boolean {
  return problem !== "not_observable_from_convex" && problem !== "not_observable_from_next";
}

function checkRequiredString(
  issues: EnvValidationIssue[],
  env: Env,
  runtime: EnvRuntime,
  variable: string,
  scope: EnvScope,
  guidance: string,
  extra?: (value: string) => string | null,
): void {
  if (!observable(scope, runtime)) {
    addIssue(
      issues,
      variable,
      scope,
      notObservableProblem(runtime)!,
      `${variable} is not observable from the ${runtime} runtime; it is managed in the other scope (Vercel for next, Convex for convex). Verify it in that scope. ${guidance}`,
    );
    return;
  }

  const value = trimmed(env, variable);
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
  runtime: EnvRuntime,
  variable: string,
  scope: EnvScope,
  extra?: (value: string) => string | null,
): void {
  if (!observable(scope, runtime)) return;
  const value = trimmed(env, variable);
  if (!isPresent(value)) return;
  if (extra) {
    const problem = extra(value);
    if (problem) {
      addIssue(issues, variable, scope, "malformed", `${variable} is malformed: ${problem}.`);
    }
  }
}

function checkUrl(value: string, requireHttps: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "expected an absolute URL";
  }
  if (!parsed.hostname) return "expected an absolute URL with a host";
  if (requireHttps && parsed.protocol !== "https:") return "expected an https:// URL";
  if (parsed.username || parsed.password) return "must not contain embedded userinfo";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "expected an http(s) URL";
  return null;
}

function checkVersionFormat(value: string): string | null {
  return /^v[1-9][0-9]{0,2}$/u.test(value) ? null : "expected a version like v1, v2, ...";
}

function base64ByteLength(value: string): number | null {
  try {
    if (!/^[A-Za-z0-9+/\-_]+={0,2}$/u.test(value)) return null;
    const normalised = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const buf = Buffer.from(normalised, "base64");
    if (buf.toString("base64").replace(/=+$/u, "") !== normalised.replace(/=+$/u, "")) return null;
    return buf.length;
  } catch {
    return null;
  }
}

function checkEncryptionKey(
  issues: EnvValidationIssue[],
  env: Env,
  runtime: EnvRuntime,
  prefix: "T3_OAUTH" | "LINEAR_OAUTH",
  scope: EnvScope,
): void {
  const versionVar = `${prefix}_ENCRYPTION_KEY_VERSION`;
  const guidance =
    "Configure a retained 32-byte AES key, base64-encoded (see .env.example). " +
    "Legacy `*_OAUTH_ENCRYPTION_KEY` is used only when the version is `v1` and the versioned key is absent.";

  if (!observable(scope, runtime)) {
    addIssue(issues, `${prefix}_ENCRYPTION_KEY_VERSION`, scope, notObservableProblem(runtime)!,
      `The ${prefix} encryption key variables are not observable from the ${runtime} runtime.`);
    return;
  }

  const versionRaw = env[versionVar];
  const version = versionRaw === undefined ? "v1" : versionRaw;
  if (versionRaw !== undefined) {
    const problem = checkVersionFormat(version);
    if (problem) {
      addIssue(issues, versionVar, scope, "malformed", `${versionVar} is malformed: ${problem}. ${guidance}`);
      // Do not attempt key resolution with an invalid version selector.
      return;
    }
  }

  const specificVar = `${prefix}_ENCRYPTION_KEY_${version.toUpperCase()}`;
  const legacyVar = `${prefix}_ENCRYPTION_KEY`;

  // Mirror runtime: fallback to legacy only when the versioned var is `undefined`
  // (not when it is "" or whitespace).
  let encoded: string | undefined = env[specificVar];
  if (encoded === undefined && version === "v1") {
    encoded = env[legacyVar];
  }

  if (encoded === undefined) {
    addIssue(issues, specificVar, scope, "missing", `${specificVar} is required but is not set. ${guidance}`);
    return;
  }

  const value = encoded.trim();
  if (value.length === 0) {
    addIssue(issues, specificVar, scope, "malformed", `${specificVar} is malformed: expected a non-empty base64 value. ${guidance}`);
    return;
  }

  const bytes = base64ByteLength(value);
  if (bytes === null || bytes !== 32) {
    addIssue(issues, specificVar, scope, "malformed", `${specificVar} is malformed: expected a base64 encoding of exactly 32 bytes. ${guidance}`);
  }
}

export function validateEnv(
  env: Env = process.env,
  runtimeOrOptions?: EnvRuntime | { runtime?: EnvRuntime },
): EnvValidationResult {
  const runtime: EnvRuntime =
    typeof runtimeOrOptions === "string"
      ? runtimeOrOptions
      : (runtimeOrOptions?.runtime ?? "all");

  const issues: EnvValidationIssue[] = [];

  // --- Next.js / Vercel side ---
  checkRequiredString(issues, env, runtime, "NEXT_PUBLIC_CONVEX_URL", "next",
    "Set it to the Convex deployment URL the browser subscribes to (https://...convex.cloud).",
    (v) => checkUrl(v, false));

  checkRequiredString(issues, env, runtime, "HELM_APP_URL", "both",
    "Set it to this deployment's origin in BOTH runtimes; mutating routes fail closed on mismatch.",
    (v) => checkUrl(v, true));

  checkRequiredString(issues, env, runtime, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "next",
    "Set it to the Clerk publishable key for this instance (pk_test_... / pk_live_...).",
    (v) => (v.length >= 10 ? null : "expected a Clerk publishable key"));

  // --- Convex side ---
  checkRequiredString(issues, env, runtime, "CLERK_FRONTEND_API_URL", "convex",
    "Set it to the Clerk Frontend API (JWT issuer) URL used by convex/auth.config.ts.",
    (v) => checkUrl(v, true));

  checkRequiredString(issues, env, runtime, "HELM_OWNER_SUBJECT", "convex",
    "Set it to the single immutable owner subject (user_...) enforced server-side.",
    (v) => (/^\S+$/u.test(v) && v.length <= 256 ? null : "expected a non-empty subject without whitespace"));

  checkRequiredString(issues, env, runtime, "LINEAR_CLIENT_ID", "convex",
    "Create a Linear OAuth application and set its client id (redirect URI <HELM_APP_URL>/api/linear/callback).",
    (v) => (v.length <= 512 ? null : "expected at most 512 characters"));

  checkOptionalString(issues, env, runtime, "LINEAR_CLIENT_SECRET", "convex",
    (v) => (v.length <= 2048 ? null : "expected at most 2048 characters"));

  checkEncryptionKey(issues, env, runtime, "T3_OAUTH", "convex");
  checkEncryptionKey(issues, env, runtime, "LINEAR_OAUTH", "convex");

  checkRequiredString(issues, env, runtime, "T3_MCP_URL", "convex",
    "Set it to the PRIVILEGED (discovery-only) T3 MCP HTTPS endpoint reachable from Convex.",
    (v) => checkUrl(v, true));

  checkRequiredString(issues, env, runtime, "T3_MCP_TOKEN", "convex",
    "Issue it server-side with `t3 auth session issue`; never log or expose it.",
    (v) => (v.length >= 1 ? null : "expected a non-empty bearer token"));

  checkRequiredString(issues, env, runtime, "T3_MCP_URL_ISOLATED", "convex",
    "Set it to the ISOLATED T3 MCP HTTPS endpoint dispatch is allowed to launch on.",
    (v) => (isValidIsolatedEndpoint(v) ? null : "expected a valid absolute https URL without embedded userinfo"));

  checkRequiredString(issues, env, runtime, "T3_MCP_TOKEN_ISOLATED", "convex",
    "Set it to the bearer credential for the ISOLATED T3 instance; dispatch reads only this token.",
    (v) => (v.length >= 1 ? null : "expected a non-empty bearer token"));

  checkRequiredString(issues, env, runtime, "T3_PROJECT_ID_ISOLATED", "convex",
    "Set it to the trusted isolated T3 project binding; missing disables dispatch.",
    (v) => (v.length >= 1 ? null : "expected a non-empty project id"));

  checkRequiredString(issues, env, runtime, "LINEAR_API_KEY", "convex",
    "Set it to a read-scoped Linear personal API key (server-side only).",
    (v) => (v.length >= 1 ? null : "expected a non-empty API key"));

  checkRequiredString(issues, env, runtime, "LINEAR_PROJECT_ID", "convex",
    "Set it to the target Linear project UUID.",
    (v) => (v.length >= 1 ? null : "expected a non-empty project id"));

  // Optional variables: validate shape only when present.
  checkOptionalString(issues, env, runtime, "NEXT_PUBLIC_CONVEX_SITE_URL", "next",
    (v) => checkUrl(v, false));
  checkOptionalString(issues, env, runtime, "NEXT_PUBLIC_HELM_T3_FIXTURES", "next",
    (v) => (v === "true" || v === "false" ? null : "expected \"true\" or \"false\""));

  const errors = issues.filter((i) => isFailing(i.problem)).map((i) => i.message);
  const ok = issues.filter((i) => isFailing(i.problem)).length === 0;

  return { ok, issues, errors };
}