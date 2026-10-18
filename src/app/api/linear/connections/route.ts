import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { ownerConvexClient, safeFailure } from "../../../../lib/linearBackend";

function present(row: {
  connectionId: unknown;
  workspaceId: string;
  workspaceName: string;
  workspaceUrlKey: string;
  scopes: string[];
  status: string;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
  lastVerifiedAt: number | null;
  lastSuccessfulReadAt: number | null;
  lastErrorCode: string | null;
}) {
  return {
    connectionId: row.connectionId,
    workspaceId: row.workspaceId,
    displayName: row.workspaceName,
    workspaceUrlKey: row.workspaceUrlKey,
    scopes: row.scopes,
    status: row.status === "reauthorizationRequired" ? "revoked" : row.status,
    lastVerifiedAt: row.lastVerifiedAt === null ? null : new Date(row.lastVerifiedAt).toISOString(),
    lastReadAt: row.lastSuccessfulReadAt === null ? null : new Date(row.lastSuccessfulReadAt).toISOString(),
    errorCode: row.lastErrorCode,
    accessExpiresAt: new Date(row.accessExpiresAt).toISOString(),
    refreshExpiresAt: row.refreshExpiresAt === null ? null : new Date(row.refreshExpiresAt).toISOString(),
  };
}

export async function GET() {
  try {
    const client = await ownerConvexClient();
    const rows = await client.action(api.linearOAuth.list, {});
    return NextResponse.json({ connections: rows.map(present) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
