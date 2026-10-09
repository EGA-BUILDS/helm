"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/**
 * Linear GraphQL probe (INTERNAL ONLY).
 *
 * EGA-677 task 1: verify blocking relationships directly against Linear's
 * GraphQL API rather than through the MCP `get_issue` surface, which exposes no
 * relation fields at all.
 *
 * Read-only by construction: the request body is validated to be a single `query`
 * document with no `mutation`, and the persisted credential is never returned.
 */

const ENDPOINT = "https://api.linear.app/graphql";

/** Reject anything that is not a plain read-only GraphQL query. */
function assertReadOnly(query: string, variables: Record<string, unknown> | null): void {
  if (/\bmutation\b/i.test(query)) throw new Error("probe is read-only: mutation rejected");
  if (!/^\s*(query|\{)/.test(query)) throw new Error("probe accepts GraphQL query documents only");
  // A mutation can also be smuggled through a variable holding an operation string.
  const serialised = JSON.stringify(variables ?? {});
  if (/\bmutation\b/i.test(serialised)) throw new Error("probe is read-only: mutation in variables");
}

export const graphql = internalAction({
  args: {
    query: v.string(),
    variables: v.optional(v.any()),
  },
  returns: v.object({
    ok: v.boolean(),
    status: v.number(),
    body: v.string(),
    errorClass: v.union(v.string(), v.null()),
  }),
  handler: async (
    _ctx,
    args,
  ): Promise<{ ok: boolean; status: number; body: string; errorClass: string | null }> => {
    const key = process.env.LINEAR_API_KEY;
    if (!key) return { ok: false, status: 0, body: "LINEAR_API_KEY not configured", errorClass: "config" };
    assertReadOnly(args.query, (args.variables ?? null) as Record<string, unknown> | null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Linear personal API keys are sent bare, without a Bearer prefix.
          Authorization: key,
        },
        body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
      });
      const body = await res.text();
      let errorClass: string | null = null;
      try {
        const parsed = JSON.parse(body) as { errors?: { message?: string }[] };
        if (parsed.errors?.length) errorClass = parsed.errors[0]?.message?.slice(0, 160) ?? "graphql error";
      } catch {
        errorClass = "non-JSON response";
      }
      return { ok: res.ok, status: res.status, body: body.slice(0, 20000), errorClass };
    } catch (e) {
      return { ok: false, status: 0, body: String((e as Error)?.message ?? e).slice(0, 300), errorClass: "transport" };
    }
  },
});
