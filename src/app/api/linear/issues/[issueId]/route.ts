import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, safeFailure } from "../../../../../lib/linearBackend";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Read one issue's full context (description plus acceptance criteria when
 * present) for an enabled mapped project (EGA-680). Owner-only: the Convex
 * action resolves `projectId` against the owner's enabled mappings and
 * refuses any project that is not one. Read-only GET.
 */
export async function GET(request: Request, context: { params: Promise<{ issueId: string }> }) {
  try {
    const { issueId } = await context.params;
    const params = new URL(request.url).searchParams;
    const projectId = (params.get("projectId") ?? "").trim();
    if (!projectId || projectId.length > 1024) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "Select a mapped Linear project to read its issue.", retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }
    if (!issueId || issueId.trim().length === 0 || issueId.length > 1024) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "Select a Linear issue to read.", retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }
    const client = await ownerConvexClient();
    const result = await client.action(api.linearIssues.read, { projectId, issueId });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: NO_STORE });
  }
}
