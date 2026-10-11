import { NextResponse } from "next/server";
import { api } from "../../../../../../../convex/_generated/api";
import { ownerConvexClient, safeFailure } from "../../../../../../lib/t3Backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allowed = new Set(["environment", "capabilities", "projects", "project", "threads", "thread"]);

export async function GET(request: Request, context: { params: Promise<{ connectionId: string; operation: string }> }) {
  try {
    const { connectionId, operation } = await context.params;
    if (!allowed.has(operation)) return NextResponse.json({ error: { code: "not_found", message: "This T3 read is unavailable.", retryable: false } }, { status: 404 });
    const url = new URL(request.url);
    const input: Record<string, unknown> = {};
    for (const key of ["projectId", "threadId", "cursor", "limit", "afterPosition", "titleContains", "itemId", "textOffset"]) {
      const value = url.searchParams.get(key);
      if (value !== null) input[key] = ["cursor", "limit", "afterPosition", "textOffset"].includes(key) ? Number(value) : value;
    }
    const statuses = url.searchParams.getAll("statuses").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    if (statuses.length) input.statuses = statuses;
    const client = await ownerConvexClient();
    const data = await client.action(api.t3OAuth.read, { connectionId: connectionId as never, operation, input });
    return NextResponse.json({ data, observedAt: new Date().toISOString(), freshness: { source: "backend", stale: false } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
