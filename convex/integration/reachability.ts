import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/**
 * EGA-677 hosted reachability probe (INTERNAL ONLY).
 *
 * Purpose: prove from the *hosted* Convex runtime whether a candidate T3 MCP
 * endpoint is reachable at all, before any credential is provisioned.
 *
 * Registered with `internalAction`, so it is NOT callable from a browser, the
 * Convex client SDK, or any public HTTP surface. Only another server-side
 * Convex function in this deployment can invoke it.
 *
 * Safety properties:
 *  - Read-only, unauthenticated probe of the RFC 9728 protected-resource
 *    metadata document, which is public by design. No credential is sent.
 *  - Never returns response bodies, headers, or secret material; only a
 *    reachability classification plus the observed status code.
 *  - Performs no launch, no mutation, and no state change.
 */

/**
 * A sanitized reachability verdict. Deliberately free of response content so
 * it is safe to render or log.
 */
export type ReachabilityProbe = {
  reachable: boolean;
  /** Observed HTTP status, or null when no response was received. */
  status: number | null;
  /** Coarse classification the caller branches on. */
  outcome:
    | "reachable"
    | "reachable-auth-required"
    | "reachable-unexpected-status"
    | "unreachable-dns"
    | "unreachable-refused"
    | "unreachable-timeout"
    | "unreachable-other";
  /** Sanitized summary; never contains response bodies or credentials. */
  detail: string;
  /** Milliseconds spent on the single bounded attempt. */
  durationMs: number;
};

const PROBE_TIMEOUT_MS = 8000;

const outcomeValidator = v.union(
  v.literal("reachable"),
  v.literal("reachable-auth-required"),
  v.literal("reachable-unexpected-status"),
  v.literal("unreachable-dns"),
  v.literal("unreachable-refused"),
  v.literal("unreachable-timeout"),
  v.literal("unreachable-other"),
);

/**
 * A closed validator makes it structurally impossible for this action to
 * return a response body, header, or credential.
 */
const probeValidator = v.object({
  reachable: v.boolean(),
  status: v.union(v.number(), v.null()),
  outcome: outcomeValidator,
  detail: v.string(),
  durationMs: v.number(),
});

export const probeEndpointReachability = internalAction({
  args: {
    /** Absolute http(s) URL of the candidate MCP endpoint. */
    targetUrl: v.string(),
  },
  returns: probeValidator,
  handler: async (_ctx, args): Promise<ReachabilityProbe> => {
    const startedAt = Date.now();

    let probeUrl: URL;
    try {
      const target = new URL(args.targetUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("unsupported-protocol");
      }
      // RFC 9728: the metadata path is the resource path with
      // /.well-known/oauth-protected-resource prefixed. Credentials in the URL
      // are dropped because only protocol + host + path are carried over.
      const resourcePath = target.pathname.endsWith("/")
        ? `${target.pathname}mcp`
        : `${target.pathname}/mcp`;
      probeUrl = new URL(
        `/.well-known/oauth-protected-resource${resourcePath}`,
        `${target.protocol}//${target.host}`,
      );
    } catch {
      return {
        reachable: false,
        status: null,
        outcome: "unreachable-other",
        detail: "targetUrl must be an absolute http(s) URL",
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "manual",
      });
      const durationMs = Date.now() - startedAt;

      const outcome: ReachabilityProbe["outcome"] =
        response.status === 401
          ? "reachable-auth-required"
          : response.ok
            ? "reachable"
            : "reachable-unexpected-status";

      // Intentionally discard the body: only the classification is returned.
      return {
        reachable: true,
        status: response.status,
        outcome,
        detail: `protected-resource metadata responded ${response.status}`,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;

      // Node/undici rejects with a generic "fetch failed"; the useful signal
      // lives on the error cause chain, so inspect both the message and codes.
      const codes: string[] = [];
      let cursor: unknown = error;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        const candidate = cursor as { code?: unknown; message?: unknown; cause?: unknown };
        if (typeof candidate.code === "string") codes.push(candidate.code);
        if (typeof candidate.message === "string") codes.push(candidate.message);
        cursor = candidate.cause;
      }
      const haystack = codes.join(" ");

      let outcome: ReachabilityProbe["outcome"] = "unreachable-other";
      if (/abort|timeout|timed out|etimedout|UND_ERR_CONNECT_TIMEOUT/i.test(haystack)) {
        outcome = "unreachable-timeout";
      } else if (/enotfound|eai_again|getaddrinfo|name not resolved|dns/i.test(haystack)) {
        outcome = "unreachable-dns";
      } else if (/econnrefused|connection refused|ECONNRESET|epipe/i.test(haystack)) {
        outcome = "unreachable-refused";
      }

      return {
        reachable: false,
        status: null,
        outcome,
        detail: "no response received from the candidate endpoint",
        durationMs,
      };
    }
  },
});