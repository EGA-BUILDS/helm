/**
 * Canonical trusted T3 Connect endpoint policy.
 *
 * This module is intentionally pure: no Node, no DOM, no imports. Both the
 * Convex backend (`convex/t3OAuth.ts`) and the browser dashboard
 * (`src/features/t3/ui.ts`, `src/features/t3/backend.ts`) bundle the exact same
 * rules, so the early client check can never accept something the backend
 * refuses, or refuse something the backend accepts.
 *
 * The backend still re-checks every outbound request. This policy is a shared
 * source of truth, not a replacement for server-side enforcement.
 */

/** The only host suffix Helm will talk to. Do not widen without an owner decision. */
export const TRUSTED_T3_DOMAIN = "t3coderelay.com";

/** True when `hostname` is the trusted domain itself or a subdomain of it. */
export function hostIsTrusted(hostname: string): boolean {
  return hostname === TRUSTED_T3_DOMAIN || hostname.endsWith(`.${TRUSTED_T3_DOMAIN}`);
}

/**
 * Why a candidate URL was refused. Callers map these onto their own vocabulary:
 * the backend throws, the browser renders a specific explanation.
 */
export type EndpointRejection =
  | "too_long"
  | "malformed"
  | "not_https"
  | "embedded_credentials"
  | "query_or_fragment"
  | "unsupported_port"
  | "untrusted_host"
  | "not_mcp_path";

export type EndpointCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: EndpointRejection };

/** Maximum accepted input length, matching the backend's stored-endpoint bound. */
export const MAX_ENDPOINT_LENGTH = 2048;

/**
 * Validate a candidate T3 Connect URL.
 *
 * `requireMcpPath` is set for the connection endpoint itself (`/mcp`), and left
 * unset for the discovery documents Helm derives from it, which live at other
 * paths on the same trusted origin.
 */
export function checkT3Endpoint(
  value: string,
  options: { readonly requireMcpPath?: boolean } = {},
): EndpointCheck {
  if (value.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: "too_long" };
  // A scheme is mandatory, and only HTTPS is permitted. Checking the scheme
  // before parsing lets "http://…" report the real problem instead of the
  // generic malformed-URL message.
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return { ok: false, reason: "malformed" };
  if (scheme !== "https") return { ok: false, reason: "not_https" };
  // Require an explicit, non-empty authority. WHATWG parsing would otherwise
  // read ambiguous input such as "https:host/mcp" or "https:///host/mcp" as a
  // valid URL, which is never what a pasted T3 Connect URL looks like.
  if (!/^https:\/\/[^/]/iu.test(value)) return { ok: false, reason: "malformed" };
  if (value.includes("?") || value.includes("#")) return { ok: false, reason: "query_or_fragment" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.username || url.password) return { ok: false, reason: "embedded_credentials" };
  if (url.search || url.hash) return { ok: false, reason: "query_or_fragment" };
  if (url.port !== "") return { ok: false, reason: "unsupported_port" };
  if (!hostIsTrusted(url.hostname)) return { ok: false, reason: "untrusted_host" };
  if (options.requireMcpPath && url.pathname !== "/mcp") return { ok: false, reason: "not_mcp_path" };
  return { ok: true, url };
}

/**
 * Normalize pasted input without guessing. Only a trailing slash on the `/mcp`
 * path is removed, because `…/mcp/` and `…/mcp` name the same endpoint and the
 * backend requires the unslashed form.
 */
export function normalizeEndpointInput(value: string): string {
  const trimmed = value.trim();
  return /\/mcp\/$/u.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
}
