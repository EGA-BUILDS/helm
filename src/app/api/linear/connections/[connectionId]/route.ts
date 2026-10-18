import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/linearBackend";

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

export async function GET(_request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await context.params;
    const client = await ownerConvexClient();
    const rows = await client.action(api.linearOAuth.list, {});
    const row = rows.find((entry) => String(entry.connectionId) === connectionId);
    if (!row) return NextResponse.json({ error: { code: "not_found", message: "Linear connection was not found.", retryable: false } }, { status: 404, headers: { "cache-control": "no-store" } });
    return NextResponse.json({ connection: present(row) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    requireSameOrigin(_request);
    const { connectionId } = await context.params;
    const client = await ownerConvexClient();
    await client.action(api.linearOAuth.disconnect, { connectionId: connectionId as never });
    return NextResponse.json({ connectionId, status: "disconnected" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}
