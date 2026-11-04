/**
 * The single definition of a T3 OAuth access tier, shared by the Convex
 * backend and the browser bundle.
 *
 * Three tiers exist:
 *  - `read-only`  — v0.1 grant. Scope `orchestration:read`. Read allowlist only.
 *  - `operate`    — separately authorised grant. Scopes
 *                   `orchestration:read orchestration:operate`. Reaches the
 *                   three-tool native write allowlist.
 *  - `full-access` — EGA-809. The exact four-scope set T3 mints when the owner
 *                   selects Full access on the consent page. It reaches the
 *                   SAME three-tool write allowlist as `operate`; the extra
 *                   `settings:write` / `source-control:write` token scopes never
 *                   authorize a Helm tool, because the allowlist is independent
 *                   of the token's scopes.
 *
 * An absent or unrecognised stored value is `read-only`. That default is
 * load-bearing: legacy rows predate the field and must never be treated as a
 * write grant by omission.
 *
 * This module is deliberately pure: no Convex imports, no network, no clock.
 * Validators are declared by their consumers so the browser bundle does not
 * pull in `convex/values`.
 */

export const T3_ACCESS_LEVELS = ["read-only", "operate", "full-access"] as const;

export type T3Access = (typeof T3_ACCESS_LEVELS)[number];

/** The tiers that may reach a native T3 write. */
export type T3WriteAccess = Extract<T3Access, "operate" | "full-access">;

export const T3_WRITE_ACCESS_LEVELS: readonly T3WriteAccess[] = ["operate", "full-access"];

/**
 * Normalise a stored/attempt access value. Anything that is not an explicit
 * write tier becomes `read-only`; legacy and malformed values are never
 * upgraded by this function.
 */
export function normalizeT3Access(value: T3Access | null | undefined): T3Access {
  return value === "operate" || value === "full-access" ? value : "read-only";
}

/**
 * True only for the two explicit write tiers. This is the one predicate the
 * OAuth tool boundary, the shared write gate and the write actions use, so they
 * cannot drift into accepting different sets.
 */
export function isT3WriteAccess(value: unknown): value is T3WriteAccess {
  return value === "operate" || value === "full-access";
}
