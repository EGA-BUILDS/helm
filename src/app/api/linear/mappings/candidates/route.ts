import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, safeFailure } from "../../../../../lib/linearBackend";

/**
 * Live candidates for the mapping form: Linear projects with per-team
 * validated started states, plus the owner's T3 projects per connection.
 * Read-only: no mapping is created, no Linear status changes, no T3 launch.
 */
export async function GET() {
  try {
    const client = await ownerConvexClient();
    const result = await client.action(api.projectMappings.candidates, {});
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}
