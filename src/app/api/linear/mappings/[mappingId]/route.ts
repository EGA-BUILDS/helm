import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../../lib/linearBackend";

export async function DELETE(_request: Request, context: { params: Promise<{ mappingId: string }> }) {
  try {
    requireSameOrigin(_request);
    const { mappingId } = await context.params;
    const client = await ownerConvexClient();
    const disabled = await client.action(api.projectMappings.disable, { mappingId: mappingId as never });
    if (!disabled) {
      return NextResponse.json(
        { error: { code: "not_found", message: "That project mapping no longer exists.", retryable: false } },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json({ mappingId, status: "disabled" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}
