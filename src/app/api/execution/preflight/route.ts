import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import {
  linearStatus,
  ownerConvexClient,
  requireSameOrigin,
  safeFailure,
} from "../../../../lib/linearBackend";

const NO_STORE = { "cache-control": "no-store" };

function invalid(message: string) {
  return NextResponse.json(
    { error: { code: "invalid_request", message, retryable: false } },
    { status: 400, headers: NO_STORE },
  );
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) {
    throw new Error("request body is too large");
  }
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/**
 * Owner-only execution preflight (EGA-761). Read-only POST: resolves the
 * enabled mapping, re-checks the Linear and T3 connections, and returns the
 * live T3 catalog snapshot plus the `blockers` list. Launches nothing: no T3
 * thread, no worktree, no Linear write. That launch is D07's job.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return invalid("Send a JSON request.");
    }
    const body: unknown = await readBoundedJson(request, 8192);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return invalid("Send a JSON request.");
    }
    const input = body as Record<string, unknown>;
    const linearProjectId =
      typeof input.linearProjectId === "string" ? input.linearProjectId.trim() : "";
    const linearTeamId =
      typeof input.linearTeamId === "string" ? input.linearTeamId.trim() : "";
    if (!linearProjectId || linearProjectId.length > 1024) {
      return invalid("Select a mapped Linear project to prepare execution.");
    }
    if (!linearTeamId || linearTeamId.length > 1024) {
      return invalid("Select a mapped Linear team to prepare execution.");
    }
    const client = await ownerConvexClient();
    const result = await client.action(api.execution.preflight, {
      linearProjectId,
      linearTeamId,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json(
      { error: failure },
      { status: linearStatus(failure), headers: NO_STORE },
    );
  }
}
