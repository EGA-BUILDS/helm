import { ownerConvexClient, requireSameOrigin, helmHomeUrl } from "./t3Backend";
import type { SafeFailure } from "./t3Failure";

/**
 * Linear route helpers. Failures use the shared classification table with
 * Linear copy and Linear transport patterns (not the T3 wording); only the
 * HTTP status mapping below is Linear-route-specific.
 */
export { classifyLinearFailure as safeFailure } from "./t3Failure";
export { ownerConvexClient, requireSameOrigin, helmHomeUrl };

/**
 * Map a classified Linear failure to an HTTP status. Anonymous calls are 401,
 * refused cross-origin mutations are 403, validation problems are 400/404/415
 * at the call site, a missing server configuration is 503, rate limiting is
 * 429, and everything else (revoked/expired/unreachable/unknown) is 502 so the
 * owner retries via reconnect or refresh rather than the same request.
 */
export function linearStatus(failure: SafeFailure): number {
  if (failure.code === "access_denied") return 401;
  if (failure.code === "origin_mismatch") return 403;
  if (failure.code === "rate_limited") return 429;
  if (failure.code === "misconfigured") return 503;
  return 502;
}
