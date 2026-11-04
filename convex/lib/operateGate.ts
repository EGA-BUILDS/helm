/**
 * Shared write gate for native T3 write operations (EGA-764 / EGA-765).
 *
 * `convex/t3Launch.ts` (EGA-681) resolved the separately-authorised `operate`
 * connection inline. Two more write features then arrived, so the same decision
 * is extracted here ONCE: if each feature re-derived it, the three paths could
 * drift, and a drift in this particular decision means a read-only credential
 * reaching a native write.
 *
 * EGA-809 adds the `full-access` OAuth tier. It is a SECOND write-capable tier,
 * not a replacement: `operate` and `full-access` grants are both accepted, and
 * every other value — including legacy/absent ones and unknown strings — is
 * still invisible. A Full-access token's extra `settings:write` /
 * `source-control:write` scopes do not widen this gate.
 *
 * Pure and dependency-free (no Convex imports, no network, no clock) so it can
 * be unit tested exhaustively and imported by both Convex and the browser. The
 * caller supplies the already-owner-scoped connection rows; this module never
 * reads the database and never sees a token.
 *
 * What it does NOT do, deliberately:
 *  - it does not widen access. A row whose `access` is anything other than one
 *    of the two explicit write tiers is never selected, so a legacy/absent
 *    value (normalised to `read-only` upstream) can never satisfy a write gate;
 *  - it does not treat an ambiguous write-capable inventory as "pick one". More
 *    than one write-capable connection (two operate rows, two full-access rows,
 *    or one of each) is a refusal, not a choice. The beta resolves writes
 *    through exactly one grant.
 */

import { isT3WriteAccess } from "./t3Access";

export type OperateRefusal =
  | "operate_not_granted"
  | "operate_ambiguous"
  | "expired"
  | "reauthorization_required"
  | "unreachable"
  | "unusable";

export type OperateVerdict =
  | { ok: true; connectionId: string; environmentId: string }
  | { ok: false; reason: OperateRefusal; detail: string };

/** The subset of a connection row this gate needs. Never includes a token. */
export interface OperateConnectionRow {
  connectionId: string;
  access: string;
  status: string;
  environmentId: string;
}

/**
 * Fixed, owner-facing refusal copy. Sanitized sentences only: no upstream text,
 * no token, no identifier beyond a bounded connection id.
 */
export const OPERATE_REFUSAL_DETAIL: Readonly<Record<OperateRefusal, string>> = Object.freeze({
  operate_not_granted: "T3 operate access has not been granted; complete the operate consent first.",
  operate_ambiguous:
    "T3 operate connection identity is ambiguous; disconnect the extra grant and try again.",
  expired: "T3 connection has expired; reconnect it to continue.",
  reauthorization_required: "T3 authorization was revoked; reconnect to continue.",
  unreachable: "T3 connection is unreachable; refresh it before continuing.",
  unusable: "T3 operate connection is not usable; reconnect it to continue.",
});

/**
 * Select the single usable write-capable connection, or explain exactly why not.
 *
 * Order matters: ambiguity is reported before usability, because "two grants"
 * is an identity problem the owner must fix regardless of either one's status.
 */
export function resolveOperateConnection(rows: readonly OperateConnectionRow[]): OperateVerdict {
  // Only a genuine `operate` or `full-access` row may satisfy a write. This is
  // the load-bearing line: a `read-only` row (or any legacy value normalised to
  // it) is invisible.
  const writeRows = rows.filter((row) => isT3WriteAccess(row.access));

  if (writeRows.length === 0) {
    return { ok: false, reason: "operate_not_granted", detail: OPERATE_REFUSAL_DETAIL.operate_not_granted };
  }
  if (writeRows.length > 1) {
    return { ok: false, reason: "operate_ambiguous", detail: OPERATE_REFUSAL_DETAIL.operate_ambiguous };
  }

  const row = writeRows[0]!;
  if (row.status === "expired") {
    return { ok: false, reason: "expired", detail: OPERATE_REFUSAL_DETAIL.expired };
  }
  if (row.status === "reauthorizationRequired") {
    return { ok: false, reason: "reauthorization_required", detail: OPERATE_REFUSAL_DETAIL.reauthorization_required };
  }
  if (row.status === "unreachable") {
    return { ok: false, reason: "unreachable", detail: OPERATE_REFUSAL_DETAIL.unreachable };
  }
  if (row.status !== "connected") {
    return { ok: false, reason: "unusable", detail: OPERATE_REFUSAL_DETAIL.unusable };
  }

  return { ok: true, connectionId: row.connectionId, environmentId: row.environmentId };
}

/**
 * The operate connection must be the environment the caller believes it is
 * talking to. A caller-supplied environment id is never trusted; the stored
 * value is compared against the expected one and any difference is refused.
 */
export function assertOperateEnvironment(
  verdict: { ok: true; connectionId: string; environmentId: string },
  expectedEnvironmentId: string,
): OperateVerdict {
  if (verdict.environmentId !== expectedEnvironmentId) {
    return {
      ok: false,
      reason: "operate_ambiguous",
      detail:
        "The target points at a different T3 environment than the operate connection; remap or reconnect first.",
    };
  }
  return verdict;
}
