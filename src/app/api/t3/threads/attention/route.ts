import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { INTERRUPT_KNOWN_MESSAGES } from "../../../../../../convex/lib/interruptErrors";
import { ownerConvexClient, requireSameOriginGet, safeFailure } from "../../../../../lib/t3Backend";

const NO_STORE = { "cache-control": "no-store" };

function invalid(message: string) {
  return NextResponse.json(
    { error: { code: "invalid_request", message, retryable: false } },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * Owner-gated, read-only attention derivation for one T3 thread (EGA-765
 * v0.2 D11). Same-origin GET: validates the bounded thread identity, delegates
 * to the owner-gated `api.t3Attention.attention` read action, and returns its
 * projection. No mutation, no interrupt, no approval response on this path —
 * when native evidence justifies `needs_attention` the envelope carries a T3
 * reference so the owner acts in T3.
 *
 * Same-origin protection mirrors the launch recovery GET: a present Origin
 * must equal the configured origin, otherwise the Referer must stay under it.
 * A bare navigation with neither header is refused — attention is for
 * same-origin fetch, never for links. Input is bounded query params only.
 */
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request);
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const projectId = url.searchParams.get("projectId");
    const threadId = url.searchParams.get("threadId");
    if (
      !connectionId || !/^[A-Za-z0-9]{1,64}$/u.test(connectionId) ||
      !projectId || projectId.trim().length === 0 || projectId.length > 256 ||
      !threadId || threadId.length === 0 || threadId.length > 128
    ) {
      return invalid("Select a T3 thread to review.");
    }
    const client = await ownerConvexClient();
    const result = await client.action(api.t3Attention.attention, {
      connectionId: connectionId as never,
      projectId: projectId.trim(),
      threadId,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    // The attention action throws only fixed invalid-request sentences (see
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
