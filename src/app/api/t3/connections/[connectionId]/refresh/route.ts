import { NextResponse } from "next/server";
import { api } from "../../../../../../../convex/_generated/api";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../../lib/t3Backend";

export async function POST(_request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    requireSameOrigin(_request);
    const { connectionId } = await context.params;
    const client = await ownerConvexClient();
    const data = await client.action(api.t3OAuth.refresh, { connectionId: connectionId as never });
    return NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
