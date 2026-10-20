import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { INTERRUPT_KNOWN_MESSAGES } from "../../../../../../convex/lib/interruptErrors";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/t3Backend";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY = 32768;

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
 * Owner-only native T3 run interrupt (EGA-765 v0.2 D11). Same-origin POST:
 * validates the interrupt fields, delegates to the operate-gated
 * `api.t3Interrupt.interrupt` action, and returns its outcome envelope.
 * Domain outcomes (requested, already_terminal, no_active_run, rejected,
 * ambiguous) are 200 envelopes — the same convention as the launch route —
 * so the owner always sees the exact reason. Nothing here interrupts without
 * an explicit owner POST; there is no GET that interrupts and no ambient
 * trigger. This path never deletes a worktree or a thread.
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
    const connectionId =
      typeof input.connectionId === "string" && /^[A-Za-z0-9]{1,64}$/u.test(input.connectionId)
        ? input.connectionId
        : null;
    const text = (value: unknown, max: number): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
    const projectId = text(input.projectId, 256);
    const threadId = text(input.threadId, 128);
    const runId = typeof input.runId === "string" && /^[^\s]{1,512}$/u.test(input.runId) ? input.runId : null;
    const reason = text(input.reason, 280);
    const clientRequestId =
      typeof input.clientRequestId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input.clientRequestId)
        ? input.clientRequestId
        : null;
    if (!connectionId) return invalid("Select a T3 connection to interrupt.");
    if (!projectId || !threadId) return invalid("Select a T3 thread to interrupt.");
    if (!runId) return invalid("Select a T3 run to interrupt.");
    if ("reason" in input && input.reason !== undefined && reason === null) {
      return invalid("Send a JSON request.");
    }
    if ("clientRequestId" in input && input.clientRequestId !== undefined && clientRequestId === null) {
      return invalid("Send a JSON request.");
    }
    const client = await ownerConvexClient();
    const result = await client.action(api.t3Interrupt.interrupt, {
      connectionId: connectionId as never,
      projectId,
      threadId,
      runId,
      ...(reason === null ? {} : { reason }),
      ...(clientRequestId === null ? {} : { clientRequestId }),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    // The interrupt action throws only fixed invalid-request sentences (see
    // convex/lib/interruptErrors.ts); those are safe to repeat verbatim.
    if (error instanceof Error && (INTERRUPT_KNOWN_MESSAGES as readonly string[]).includes(error.message)) {
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
