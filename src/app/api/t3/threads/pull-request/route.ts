import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { ownerConvexClient, safeFailure } from "../../../../../lib/t3Backend";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Owner-gated, read-only pull-request verification for one T3 thread (EGA-766).
 *
 * GET only: this path reads T3 and GitHub and writes nothing. There is no Git
 * write capability anywhere behind it — the GitHub client issues `GET` only.
 *
 * Same-origin protection mirrors the attention read: browsers do not attach an
 * `Origin` header to a same-origin GET, so a present Origin must equal the
 * configured origin, otherwise the Referer must stay under it. A bare
 * navigation carrying neither header is refused — this endpoint is for the
 * dashboard's own fetch, never for a link.
 */
export async function GET(request: Request) {
  try {
    const configured = process.env.HELM_APP_URL;
    let allowedOrigin: string | undefined;
    try {
      allowedOrigin = configured ? new URL(configured).origin : undefined;
    } catch {
      allowedOrigin = undefined;
    }
    if (!allowedOrigin) {
      return NextResponse.json(
        { error: safeFailure(new Error("cross_origin_request")) },
        { status: 502, headers: NO_STORE },
      );
    }
    const origin = request.headers.get("origin");
    if (origin) {
      if (origin !== allowedOrigin) {
        return NextResponse.json(
          { error: safeFailure(new Error("cross_origin_request")) },
          { status: 502, headers: NO_STORE },
        );
      }
    } else {
      const referer = request.headers.get("referer");
      if (!referer || !referer.startsWith(`${allowedOrigin}/`)) {
        return NextResponse.json(
          { error: safeFailure(new Error("cross_origin_request")) },
          { status: 502, headers: NO_STORE },
        );
      }
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const threadId = url.searchParams.get("threadId");
    if (
      !connectionId || !/^[A-Za-z0-9]{1,64}$/u.test(connectionId) ||
      !threadId || threadId.length === 0 || threadId.length > 128
    ) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "Select a T3 thread to review.", retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }

    const client = await ownerConvexClient();
    const result = await client.action(api.verifiedPullRequest.verify, {
      connectionId: connectionId as never,
      threadId,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json(
      { error: failure },
      { status: failure.code === "access_denied" ? 401 : 502, headers: NO_STORE },
    );
  }
}
