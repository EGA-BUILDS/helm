"use node";

import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Shared Linear OAuth primitives.
 *
 * Kept in a dependency-free (no Convex ctx) module so the PKCE derivation,
 * scope gating, callback validation, workspace-identity parsing and encryption
 * round-trip can be unit tested without network or a Convex runtime. The
 * `linearOAuth.ts` action module is the only runtime caller.
 */

export const LINEAR_AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_TOKEN_HOST = "api.linear.app";
export const LINEAR_AUTHORIZE_HOST = "linear.app";

/** Minimal issue read + issue write granularity requested from Linear. */
export const LINEAR_REQUESTED_SCOPES = ["read", "write"] as const;
const LINEAR_ALLOWED_SCOPES = new Set<string>(LINEAR_REQUESTED_SCOPES);

export const LINEAR_REQUEST_TIMEOUT_MS = 10_000;
export const LINEAR_MAX_BODY_BYTES = 1_048_576;

export const LINEAR_WORKSPACE_IDENTITY_QUERY =
  "query { viewer { id name } organization { id name urlKey } }";

/** Configured public OAuth client. No dynamic registration exists: fail CLOSED. */
export function linearClientId(): string {
  const raw = process.env.LINEAR_CLIENT_ID;
  if (!raw || raw.length < 1 || raw.length > 512) throw new Error("Linear OAuth is not configured");
  return raw;
}

export function linearClientSecret(): string | undefined {
  const raw = process.env.LINEAR_CLIENT_SECRET;
  if (!raw) return undefined;
  if (raw.length < 1 || raw.length > 2048) throw new Error("Linear OAuth is not configured");
  return raw;
}

/** Callback route path, built from HELM_APP_URL (mirror `/api/t3/callback`). */
export function linearCallbackUri(): string {
  const base = process.env.HELM_APP_URL;
  if (!base) throw new Error("Helm callback URL is not configured");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Helm callback URL is not configured");
  return new URL("/api/linear/callback", url).href;
}

function linearEncryptionKey(version = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION ?? "v1"): Buffer {
  if (!/^v[1-9][0-9]{0,2}$/u.test(version)) throw new Error("Linear OAuth is not configured");
  const encoded = process.env[`LINEAR_OAUTH_ENCRYPTION_KEY_${version.toUpperCase()}`] ??
    (version === "v1" ? process.env.LINEAR_OAUTH_ENCRYPTION_KEY : undefined);
  if (!encoded) throw new Error("Linear OAuth is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Linear OAuth is not configured");
  return key;
}

export function encryptLinearSecret(value: string, purpose: string): string {
  const version = process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION ?? "v1";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", linearEncryptionKey(version), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [version, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptLinearSecret(value: string, purpose: string): string {
  const parts = value.split(".");
  const versioned = parts.length === 4 && /^v[1-9][0-9]{0,2}$/u.test(parts[0] ?? "");
  const version = versioned ? parts.shift()! : "v1";
  if (parts.length !== 3) throw new Error("Stored credential is invalid");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part!, "base64url"));
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) throw new Error("Stored credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", linearEncryptionKey(version), iv);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export const linearStateDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const linearB64url = (value: Buffer): string => value.toString("base64url");

/** RFC 7636 S256 challenge derivation. */
export function linearPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function linearAccessPurpose(ownerIssuer: string, ownerSubject: string, workspaceId: string): string {
  return `linear-access:${ownerIssuer}:${ownerSubject}:${workspaceId}`;
}

export function linearRefreshPurpose(ownerIssuer: string, ownerSubject: string, workspaceId: string): string {
  return `linear-refresh:${ownerIssuer}:${ownerSubject}:${workspaceId}`;
}

export function linearPkcePurpose(ownerIssuer: string, ownerSubject: string, attemptId: string): string {
  return `linear-pkce:${ownerIssuer}:${ownerSubject}:${attemptId}`;
}

export function buildLinearAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: readonly string[];
}): string {
  const url = new URL(LINEAR_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...args.scopes].join(","));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/**
 * Scope gate: the granted scope string must be a non-empty subset of
 * `read,write`. Anything beyond those two is rejected, never stored.
 */
export function parseLinearGrantedScopes(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Linear granted permissions exceed read and write access");
  }
  const scopes = value.split(/[,\s]+/u).map((part) => part.trim()).filter(Boolean);
  if (scopes.length === 0 || scopes.length > 16) {
    throw new Error("Linear granted permissions exceed read and write access");
  }
  for (const scope of scopes) {
    if (!LINEAR_ALLOWED_SCOPES.has(scope)) {
      throw new Error("Linear granted permissions exceed read and write access");
    }
  }
  return [...new Set(scopes)];
}

export function validateLinearCallbackParams(args: { state: unknown; code?: unknown; error?: unknown }): void {
  const { state, code, error } = args;
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
      (code !== undefined && (typeof code !== "string" || code.length === 0 || code.length > 4096)) ||
      (error !== undefined && (typeof error !== "string" || error.length === 0 || error.length > 128)) ||
      (code !== undefined) === (error !== undefined)) {
    throw new Error("Linear OAuth callback is invalid");
  }
}

export interface LinearWorkspaceIdentity {
  viewerId: string;
  viewerName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceUrlKey: string;
}

function requiredIdentityString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new Error(`Linear workspace identity is unavailable (${label})`);
  }
  return value;
}

/** Strictly parse the viewer/organization identity read; GraphQL errors fail closed. */
export function parseLinearWorkspaceIdentity(value: unknown): LinearWorkspaceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Linear workspace identity is unavailable");
  }
  const root = value as Record<string, unknown>;
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new Error("Linear workspace identity is unavailable");
  }
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Linear workspace identity is unavailable");
  }
  const viewer = (data as Record<string, unknown>).viewer;
  const organization = (data as Record<string, unknown>).organization;
  if (!viewer || typeof viewer !== "object" || Array.isArray(viewer) ||
      !organization || typeof organization !== "object" || Array.isArray(organization)) {
    throw new Error("Linear workspace identity is unavailable");
  }
  const viewerRecord = viewer as Record<string, unknown>;
  const orgRecord = organization as Record<string, unknown>;
  return {
    viewerId: requiredIdentityString(viewerRecord.id, "viewer id"),
    viewerName: requiredIdentityString(viewerRecord.name, "viewer name"),
    workspaceId: requiredIdentityString(orgRecord.id, "organization id"),
    workspaceName: requiredIdentityString(orgRecord.name, "organization name"),
    workspaceUrlKey: requiredIdentityString(orgRecord.urlKey, "organization urlKey"),
  };
}

/**
 * Bounded HTTPS fetch for the two fixed Linear hosts. Explicit timeout, body
 * size cap, manual redirect handling (never followed across origins).
 */
export async function linearFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Linear request target is not supported");
  }
  const allowed =
    (url.host === LINEAR_TOKEN_HOST && url.pathname.startsWith("/oauth/")) ||
    (url.host === LINEAR_TOKEN_HOST && url.pathname === "/graphql");
  if (!allowed) throw new Error("Linear request target is not supported");
  if (init?.redirect !== undefined && init.redirect !== "manual" && init.redirect !== "error") {
    throw new Error("Redirects are disabled");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Linear request timed out")), LINEAR_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, { ...init, redirect: "manual", signal: controller.signal });
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null && /^\d+$/u.test(lengthHeader.trim()) && Number(lengthHeader) > LINEAR_MAX_BODY_BYTES) {
      throw new Error("Linear response exceeded size limit");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > LINEAR_MAX_BODY_BYTES) throw new Error("Linear response exceeded size limit");
    return new Response(buffer, { status: response.status, headers: response.headers });
  } catch (error) {
    if (error instanceof Error && error.message === "Linear response exceeded size limit") throw error;
    if (error instanceof Error && /timed out|aborted|aborted/i.test(`${error.name} ${error.message}`)) {
      throw new Error("Linear request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function linearJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Linear request failed (${response.status})`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error("Linear returned an invalid response");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Linear returned an invalid response");
  return value as Record<string, unknown>;
}

export function requiredTokenString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) {
    throw new Error(`Linear ${label} is unavailable`);
  }
  return value;
}

export function requiredTokenLifetime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Linear returned an invalid token lifetime");
  if (value <= 0 || value > 31_536_000) throw new Error("Linear returned an invalid token lifetime");
  return value;
}
