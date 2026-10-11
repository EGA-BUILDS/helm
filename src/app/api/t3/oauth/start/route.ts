import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/t3Backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: { code: "invalid_request", message: "Send a JSON request.", retryable: false } }, { status: 415 });
    }
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || typeof (body as { endpoint?: unknown }).endpoint !== "string") {
      return NextResponse.json({ error: { code: "invalid_endpoint", message: "Enter a supported T3 Connect endpoint.", retryable: false } }, { status: 400 });
    }
    const input = body as { endpoint: string; connectionId?: string };
    const client = await ownerConvexClient();
    const result = await client.action(api.t3OAuth.start, { endpoint: input.endpoint, connectionId: input.connectionId as never });
    return NextResponse.json({ attemptId: result.attemptId, authorizationUrl: result.authorizationUrl, expiresAt: new Date(result.expiresAt).toISOString() }, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : failure.code === "invalid_endpoint" ? 400 : 502, headers: { "cache-control": "no-store" } });
  }
}
