"use node";

/**
 * Owner-approved native write target (v0.2 write-safety gate).
 *
 * Every native T3 write path (`t3Launch.launch`, `t3Send.send`,
 * `t3Interrupt.interrupt`) resolves the saved `operate` OAuth grant and sends
 * the tool call to THAT grant's endpoint. The grant's environment and the
 * project mapping are already compared to each other, and `safeFetch` enforces
 * the trusted-HTTPS endpoint policy. What none of that proves is that the
 * grant's destination is a target the OWNER deliberately approved for writes:
 * a correctly-scoped operate grant pointed at the real relay looks identical to
 * one pointed at a disposable instance.
 *
 * This module closes that gap with an explicit, fail-closed declaration:
 *
 *   T3_NATIVE_WRITE_ENDPOINT     exact MCP endpoint approved for native writes
 *   T3_NATIVE_WRITE_ENVIRONMENTS comma-separated T3 environment ids approved
 *                                for native writes
 *
 * Both must be configured. When either is absent, empty, or malformed, native
 * writes are REFUSED — not silently allowed — because the whole point is that
 * an unconfigured deployment must never inherit "whatever the current grant
 * points at". The read path (`t3OAuth.read`) is untouched: only the three write
 * tools pass through this gate.
 *
 * The endpoint comparison is an exact string comparison against the STORED
 * connection endpoint after the same trailing-slash normalization the connect
 * flow applies. No hostname suffix, display label, or substring match is
 * accepted as proof of identity. We deliberately do not re-implement the
 * trusted-host policy here: the stored endpoint already passed
 * `checkT3Endpoint` at connect time and `safeFetch` re-validates every
 * outbound URL, so equality with an approved value is the additional fact this
 * gate contributes.
 *
 * Pure and dependency-free apart from the default `process.env`, so it is
 * exhaustively unit-testable and reads no database and no token.
 */

import { normalizeEndpointInput } from "./t3EndpointPolicy";

/** Convex environment variable naming the endpoint approved for native writes. */
export const NATIVE_WRITE_ENDPOINT_VAR = "T3_NATIVE_WRITE_ENDPOINT";

/** Convex environment variable naming the environment ids approved for native writes. */
export const NATIVE_WRITE_ENVIRONMENTS_VAR = "T3_NATIVE_WRITE_ENVIRONMENTS";

/** Matches the stored-endpoint bound used by the connection flow. */
const MAX_ENDPOINT_LENGTH = 2048;

/** Longest accepted environment id. T3 environment ids are short opaque strings. */
const MAX_ENVIRONMENT_ID_LENGTH = 256;

/** Bounded, opaque environment id: no whitespace, no comma, no control characters. */
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/u;

export type NativeWriteTargetRefusal =
  | "endpoint_not_configured"
  | "environments_not_configured"
  | "endpoint_malformed"
  | "environments_malformed"
  | "endpoint_mismatch"
  | "environment_mismatch";

/**
 * Fixed owner-facing copy. Every sentence names the configuration or the
 * mismatch and never echoes a configured value, an endpoint, or a token.
 */
export const NATIVE_WRITE_REFUSAL_DETAIL: Readonly<Record<NativeWriteTargetRefusal, string>> = Object.freeze({
  endpoint_not_configured:
    "Native T3 writes are disabled: the approved write endpoint is not configured. " +
    `Set ${NATIVE_WRITE_ENDPOINT_VAR} to the exact MCP endpoint of the disposable T3 instance approved for writes.`,
  environments_not_configured:
    "Native T3 writes are disabled: no approved write environment is configured. " +
    `Set ${NATIVE_WRITE_ENVIRONMENTS_VAR} to the T3 environment id approved for writes.`,
  endpoint_malformed:
    "Native T3 writes are disabled: the approved write endpoint is malformed. " +
    `Fix ${NATIVE_WRITE_ENDPOINT_VAR}; the configured value is never echoed back.`,
  environments_malformed:
    "Native T3 writes are disabled: the approved write environment list is malformed. " +
    `Fix ${NATIVE_WRITE_ENVIRONMENTS_VAR}; the configured value is never echoed back.`,
  endpoint_mismatch:
    "The operate connection does not point at the approved write endpoint; no native write was sent.",
  environment_mismatch:
    "The operate connection is in a different T3 environment than the approved write environment; no native write was sent.",
});

export type NativeWriteTargetConfig =
  | { ok: true; endpoint: string; environments: readonly string[] }
  | { ok: false; reason: NativeWriteTargetRefusal };

/**
 * Light structural check for the configured endpoint. The authoritative
 * trusted-host/HTTPS policy lives in `t3EndpointPolicy` and is enforced on the
 * stored connection and on every outbound request; this catches an obvious
 * configuration mistake early without duplicating that policy.
 */
function isStructurallyValidEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return false;
  if (/\s/u.test(value)) return false;
  if (!/^https:\/\/[^/]/iu.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  return true;
}

/**
 * Read and validate the approved write target from the environment.
 *
 * Validation is total and fail-closed: any malformed entry refuses the whole
 * configuration rather than silently skipping it, because a partially parsed
 * allowlist would authorize a target the operator did not intend.
 */
export function resolveNativeWriteTargetConfig(
  env: Record<string, string | undefined> = process.env,
): NativeWriteTargetConfig {
  const rawEndpoint = env[NATIVE_WRITE_ENDPOINT_VAR]?.trim();
  if (!rawEndpoint) return { ok: false, reason: "endpoint_not_configured" };
  const endpoint = normalizeEndpointInput(rawEndpoint);
  if (!isStructurallyValidEndpoint(endpoint)) return { ok: false, reason: "endpoint_malformed" };

  const rawEnvironments = env[NATIVE_WRITE_ENVIRONMENTS_VAR];
  if (rawEnvironments === undefined || rawEnvironments.trim().length === 0) {
    return { ok: false, reason: "environments_not_configured" };
  }

  const environments: string[] = [];
  for (const part of rawEnvironments.split(",")) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    if (candidate.length > MAX_ENVIRONMENT_ID_LENGTH || !ENVIRONMENT_ID_PATTERN.test(candidate)) {
      return { ok: false, reason: "environments_malformed" };
    }
    if (!environments.includes(candidate)) environments.push(candidate);
  }
  if (environments.length === 0) return { ok: false, reason: "environments_not_configured" };

  return { ok: true, endpoint, environments };
}

export type NativeWriteTargetCheck =
  | { ok: true }
  | { ok: false; reason: NativeWriteTargetRefusal; detail: string };

/**
 * Decide whether the resolved operate grant may receive a native write.
 *
 * `endpoint` and `environmentId` must be the STORED values from the operate
 * connection, never caller input. Both comparisons are exact.
 */
export function authorizeNativeWriteTarget(
  target: { endpoint: string; environmentId: string },
  config: NativeWriteTargetConfig,
): NativeWriteTargetCheck {
  if (!config.ok) {
    return { ok: false, reason: config.reason, detail: NATIVE_WRITE_REFUSAL_DETAIL[config.reason] };
  }
  if (normalizeEndpointInput(target.endpoint) !== config.endpoint) {
    return { ok: false, reason: "endpoint_mismatch", detail: NATIVE_WRITE_REFUSAL_DETAIL.endpoint_mismatch };
  }
  if (!config.environments.includes(target.environmentId)) {
    return { ok: false, reason: "environment_mismatch", detail: NATIVE_WRITE_REFUSAL_DETAIL.environment_mismatch };
  }
  return { ok: true };
}

/**
 * Convenience for the three write actions: resolve the configuration from the
 * deployment environment and check one stored grant in a single call.
 */
export function guardNativeWriteTarget(
  target: { endpoint: string; environmentId: string },
  env: Record<string, string | undefined> = process.env,
): NativeWriteTargetCheck {
  return authorizeNativeWriteTarget(target, resolveNativeWriteTargetConfig(env));
}
