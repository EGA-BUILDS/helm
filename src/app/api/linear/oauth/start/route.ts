import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/linearBackend";

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) throw new Error("request body is too large");
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
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: { code: "invalid_request", message: "Send a JSON request.", retryable: false } }, { status: 415 });
    }
    const body: unknown = await readBoundedJson(request, 8192);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: { code: "invalid_request", message: "Send a JSON request.", retryable: false } }, { status: 400 });
    }
    const input = body as { connectionId?: string };
    if (input.connectionId !== undefined && typeof input.connectionId !== "string") {
      return NextResponse.json({ error: { code: "invalid_request", message: "Send a JSON request.", retryable: false } }, { status: 400 });
    }
    const client = await ownerConvexClient();
    const result = await client.action(api.linearOAuth.start, {
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId as never }),
    });
    return NextResponse.json({ attemptId: result.attemptId, authorizationUrl: result.authorizationUrl, expiresAt: new Date(result.expiresAt).toISOString() }, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: failure.code === "access_denied" ? 401 : 502, headers: { "cache-control": "no-store" } });
  }
}
