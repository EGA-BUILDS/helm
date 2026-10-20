import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";

/**
 * The failure vocabulary is pure and lives in its own module so it can be unit
 * tested without loading the Clerk or Convex server runtimes.
 */
export { classifyT3Failure as safeFailure } from "./t3Failure";

export async function ownerConvexClient(): Promise<ConvexHttpClient> {
  const { userId, getToken } = await auth();
  if (!userId) throw new Error("unauthorized");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("backend_unavailable");
  const token = await getToken();
  if (!token) throw new Error("unauthorized");
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/**
 * Same-origin check for a READ the dashboard performs with `fetch`.
 *
 * Browsers do NOT attach an `Origin` header to a same-origin GET, so
 * `requireSameOrigin` — which demands one — rejects every legitimate read.
 * The rule is: a present `Origin` must equal the configured origin; otherwise
 * the `Referer` must stay under it. A bare navigation carrying neither header
 * is refused: these endpoints are for the dashboard's own fetch, never for a
 * link. State-changing requests keep using `requireSameOrigin`.
 */
export function requireSameOriginGet(request: Request): void {
  const configured = process.env.HELM_APP_URL;
  let allowedOrigin: string | undefined;
  try { allowedOrigin = configured ? new URL(configured).origin : undefined; } catch { allowedOrigin = undefined; }
  if (!allowedOrigin) throw new Error("cross_origin_request");
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin !== allowedOrigin) throw new Error("cross_origin_request");
    return;
  }
  const referer = request.headers.get("referer");
  if (!referer || !referer.startsWith(`${allowedOrigin}/`)) throw new Error("cross_origin_request");
}

export function requireSameOrigin(request: Request): void {
  const configured = process.env.HELM_APP_URL;
  const origin = request.headers.get("origin");
  let allowedOrigin: string | undefined;
  try { allowedOrigin = configured ? new URL(configured).origin : undefined; } catch { allowedOrigin = undefined; }
  if (!allowedOrigin || !origin || origin !== allowedOrigin) {
    throw new Error("cross_origin_request");
  }
}

export function helmHomeUrl(): URL {
  const configured = process.env.HELM_APP_URL;
  let url: URL;
  try { url = new URL(configured ?? ""); } catch { throw new Error("backend_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("backend_unavailable");
  return new URL("/", url);
}
