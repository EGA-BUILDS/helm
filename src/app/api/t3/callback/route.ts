import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { helmHomeUrl, ownerConvexClient } from "../../../../lib/t3Backend";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.href.length > 8192 || ["state", "code", "error", "iss"].some((key) => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.has("code") && url.searchParams.has("error"))) {
    const destination = helmHomeUrl();
    destination.searchParams.set("t3", "failed");
    return NextResponse.redirect(destination, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const issuer = url.searchParams.get("iss") ?? undefined;
  try {
    const client = await ownerConvexClient();
    const result = await client.action(api.t3OAuth.callback, { state, code, error, issuer });
    const destination = helmHomeUrl();
    destination.searchParams.set("t3", result.status);
    return NextResponse.redirect(destination, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch {
    const destination = helmHomeUrl();
    destination.searchParams.set("t3", "failed");
    return NextResponse.redirect(destination, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
}
