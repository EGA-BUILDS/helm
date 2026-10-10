"use node";

/**
 * Isolated credential resolution (EGA-677 hardening, dispatch safety).
 *
 * Helm dispatch, and only Helm dispatch, talks to the ISOLATED T3 instance. The
 * isolated endpoint and bearer token are therefore the ONLY sources of the
 * values used to build an MCP transport, and there is deliberately no fallback
 * chain: consulting `T3_MCP_URL` / `T3_MCP_TOKEN` here would silently aim an
 * "isolated" launch at the PRIVILEGED instance whenever the isolated pair was
 * not configured. That is the whole reason this module exists.
 *
 * Resolution is fail-closed and total:
 *
 *   - endpoint absent  -> refused
 *   - token absent     -> refused
 *   - endpoint not an absolute https URL, unparseable, or carrying embedded
 *     userinfo (`https://user:pass@host`) -> refused
 *
 * A refusal happens before a transport is ever constructed, so no request, no
 * handshake and no launch can be issued with half a configuration.
 *
 * Nothing in here reads, returns or logs a credential value. The refusal
 * vocabulary is fixed: it names the missing/invalid VARIABLE and nothing else,
 * so an operator can fix the deployment without the value ever crossing a
 * return boundary.
 *
 * This module is a pure helper. It registers no Convex function.
 *
 * It carries `"use node"` because it reads `process.env` and its only consumer,
 * `convex/dispatch.ts`, is a node action: the two must land in the same runtime.
 */

/** Convex environment variable holding the ISOLATED T3 MCP endpoint. */
export const ISOLATED_ENDPOINT_VAR = "T3_MCP_URL_ISOLATED";

/** Convex environment variable holding the ISOLATED T3 MCP bearer token. */
export const ISOLATED_TOKEN_VAR = "T3_MCP_TOKEN_ISOLATED";

/**
 * The privileged variables, named only so a refusal can state plainly that they
 * are NOT consulted. They are never read here: reading them is the fallback this
 * module exists to remove.
 */
const PRIVILEGED_ENDPOINT_VAR = "T3_MCP_URL";
const PRIVILEGED_TOKEN_VAR = "T3_MCP_TOKEN";

/**
 * Why isolated configuration was refused. Deliberately a closed set: a caller
 * can switch on it, and no member can carry a configured value.
 */
export type IsolatedConfigFailure =
  | "isolated_endpoint_not_configured"
  | "isolated_token_not_configured"
  | "isolated_endpoint_invalid";

/**
 * Result of resolving the isolated pair.
 *
 * `endpoint` and `token` are present only on the `ok` branch, so a caller that
 * wants to build a transport must first prove it has a complete configuration.
 */
export type IsolatedConfigResolution =
  | { ok: true; endpoint: string; token: string }
  | { ok: false; failure: IsolatedConfigFailure };

/**
 * Resolve the isolated instance's endpoint and token.
 *
 * Reads the environment at CALL time (never at module load) so a configured
 * deployment and a misconfigured one are distinguished per invocation, and so
 * the resolution is directly testable with a plain record.
 *
 * @param env Environment to read. Defaults to the deployment's environment.
 */
export function resolveIsolatedDispatchConfig(
  env: Record<string, string | undefined> = process.env,
): IsolatedConfigResolution {
  // Trim, so a variable set to whitespace counts as "not configured" rather
  // than producing a transport aimed at a blank URL.
  const endpoint = env[ISOLATED_ENDPOINT_VAR]?.trim();
  const token = env[ISOLATED_TOKEN_VAR]?.trim();

  if (!endpoint) {
    return { ok: false, failure: "isolated_endpoint_not_configured" };
  }
  if (!token) {
    return { ok: false, failure: "isolated_token_not_configured" };
  }

  // Only https is acceptable for a hosted runtime: an http endpoint would send
  // the bearer token in cleartext, and a non-http scheme cannot be transported
  // by StreamableHTTP at all.
  if (!endpoint.startsWith("https://")) {
    return { ok: false, failure: "isolated_endpoint_invalid" };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, failure: "isolated_endpoint_invalid" };
  }
  // An absolute URL with no host (`https://`) would construct but resolve
  // nowhere, and userinfo (`https://user:secret@host`) hides a credential
  // inside the endpoint itself.
  if (!parsed.host || parsed.username || parsed.password) {
    return { ok: false, failure: "isolated_endpoint_invalid" };
  }

  return { ok: true, endpoint, token };
}

/**
 * Operator-facing detail for a refusal. Names the variable, never the value:
 * an endpoint can carry userinfo and a token must never be echoed at all.
 */
export function isolatedConfigDetail(
  resolution: Extract<IsolatedConfigResolution, { ok: false }>,
): string {
  switch (resolution.failure) {
    case "isolated_endpoint_not_configured":
      return (
        `${ISOLATED_ENDPOINT_VAR} is not configured; isolated dispatch is disabled. ` +
        `${PRIVILEGED_ENDPOINT_VAR} is never used as a fallback.`
      );
    case "isolated_token_not_configured":
      return (
        `${ISOLATED_TOKEN_VAR} is not configured; isolated dispatch is disabled. ` +
        `${PRIVILEGED_TOKEN_VAR} is never used as a fallback.`
      );
    case "isolated_endpoint_invalid":
      return (
        `${ISOLATED_ENDPOINT_VAR} is not a valid absolute https URL; isolated dispatch is disabled. ` +
        `The configured value is never echoed back.`
      );
  }
}
