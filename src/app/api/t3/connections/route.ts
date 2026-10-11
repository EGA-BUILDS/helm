import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { ownerConvexClient, safeFailure } from "../../../../lib/t3Backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = await ownerConvexClient();
    const rows = await client.action(api.t3OAuth.list, {});
    const connections = rows.map((row) => ({
      connectionId: row.connectionId,
      displayName: row.environmentLabel,
      endpoint: row.endpoint,
      environmentId: row.environmentId,
      access: row.access,
      status: row.status === "reauthorizationRequired" ? "revoked" : row.status,
      lastVerifiedAt: row.lastVerifiedAt === null ? null : new Date(row.lastVerifiedAt).toISOString(),
      lastReadAt: row.lastSuccessfulReadAt === null ? null : new Date(row.lastSuccessfulReadAt).toISOString(),
      errorCode: row.lastErrorCode,
      expiresAt: new Date(row.expiresAt).toISOString(),
    }));
    return NextResponse.json({ connections }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
