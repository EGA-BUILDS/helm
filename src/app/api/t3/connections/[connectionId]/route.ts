import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/t3Backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await context.params;
    const client = await ownerConvexClient();
    const rows = await client.action(api.t3OAuth.list, {});
    const row = rows.find((entry) => String(entry.connectionId) === connectionId);
    if (!row) return NextResponse.json({ error: { code: "not_found", message: "T3 connection was not found.", retryable: false } }, { status: 404, headers: { "cache-control": "no-store" } });
    return NextResponse.json({ connection: {
      connectionId: row.connectionId, displayName: row.environmentLabel, endpoint: row.endpoint,
      environmentId: row.environmentId, access: row.access,
      status: row.status === "reauthorizationRequired" ? "revoked" : row.status,
      lastVerifiedAt: row.lastVerifiedAt === null ? null : new Date(row.lastVerifiedAt).toISOString(),
      lastReadAt: row.lastSuccessfulReadAt === null ? null : new Date(row.lastSuccessfulReadAt).toISOString(),
      errorCode: row.lastErrorCode,
      expiresAt: new Date(row.expiresAt).toISOString(),
    } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    requireSameOrigin(_request);
    const { connectionId } = await context.params;
    const client = await ownerConvexClient();
    await client.action(api.t3OAuth.disconnect, { connectionId: connectionId as never });
    return NextResponse.json({ connectionId, status: "disconnected" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
