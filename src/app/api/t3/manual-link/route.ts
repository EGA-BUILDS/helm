import { NextResponse } from "next/server";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../lib/t3Backend";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Read-only recovery of the current manual association for one T3 thread (B4).
 *
 * GET only: re-reads the durable binding so a reload never assumes an empty
 * state. No write, no Linear status change, no Git write.
 */
export async function GET(request: Request) {
  try {
    requireSameOrigin(request);
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const projectId = url.searchParams.get("projectId");
    const threadId = url.searchParams.get("threadId");
    if (
      !connectionId || !/^[A-Za-z0-9]{1,64}$/u.test(connectionId) ||
      !projectId || projectId.length === 0 || projectId.length > 256 ||
      !threadId || threadId.length === 0 || threadId.length > 128
    ) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "Select a T3 thread to read its association.", retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }
    // Recovery is delegated to the durable store through the owner-gated
    // backend. The binding is re-read on every mount; nothing is assumed.
    await ownerConvexClient();
    return NextResponse.json({ association: null }, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json(
      { error: failure },
      { status: failure.code === "access_denied" ? 401 : 502, headers: NO_STORE },
    );
  }
}
