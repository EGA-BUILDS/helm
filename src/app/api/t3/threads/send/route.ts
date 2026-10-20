import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { SEND_KNOWN_MESSAGES } from "../../../../../../convex/lib/sendErrors";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/t3Backend";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY = 32768;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

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
 * Owner-only native T3 follow-up send (EGA-764 D10). Same-origin POST:
 * validates the reviewed follow-up fields, delegates to the owner-gated
 * `api.t3Send.send` action, and returns its outcome envelope. Domain outcomes
 * (accepted, queued, rejected, ambiguous) are 200 envelopes — the same
 * convention as the execution preflight and the native launch — so the owner
 * always sees the exact reason. Nothing here sends without an explicit owner
 * POST; there is no GET that sends and no ambient trigger.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return invalid("Send a JSON request.");
    }
    const body: unknown = await readBoundedJson(request, MAX_BODY);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return invalid("Send a JSON request.");
    }
    const input = body as Record<string, unknown>;
    const text = (value: unknown, max: number): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
    const connectionId = text(input.connectionId, 256);
    const projectId = text(input.projectId, 1024);
    const threadId = text(input.threadId, 128);
    const message = text(input.message, 8000);
    const clientRequestId =
      typeof input.clientRequestId === "string" && CLIENT_REQUEST_ID_PATTERN.test(input.clientRequestId)
        ? input.clientRequestId
        : null;
    if (!connectionId) return invalid("Select a T3 connection to send from.");
    if (!projectId || !threadId) return invalid("Select a thread to follow up on.");
    if (!message) return invalid("The follow-up message must not be empty.");
    if (!clientRequestId) return invalid("Send a JSON request.");
    const client = await ownerConvexClient();
    const result = await client.action(api.t3Send.send, {
      // The Convex validator checks the connection id type; a malformed id
      // surfaces as a failure below, never as an unhandled rejection.
      connectionId: connectionId as Id<"t3Connections">,
      projectId,
      threadId,
      message,
      clientRequestId,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    // The send action throws only fixed invalid-request sentences (see
    // convex/lib/sendErrors.ts); those are safe to repeat verbatim.
    if (error instanceof Error && (SEND_KNOWN_MESSAGES as readonly string[]).includes(error.message)) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: error.message, retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }
    const failure = safeFailure(error);
    return NextResponse.json(
      { error: failure },
      { status: failure.code === "access_denied" ? 401 : 502, headers: NO_STORE },
    );
  }
}
