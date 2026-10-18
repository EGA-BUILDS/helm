import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../lib/linearBackend";

function present(row: {
  mappingId: unknown;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearProjectName: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  t3ConnectionId: unknown;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ProjectTitle: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
  startedStateName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    mappingId: row.mappingId,
    linearWorkspaceId: row.linearWorkspaceId,
    linearProjectId: row.linearProjectId,
    linearProjectName: row.linearProjectName,
    linearTeamId: row.linearTeamId,
    linearTeamKey: row.linearTeamKey,
    linearTeamName: row.linearTeamName,
    t3ConnectionId: row.t3ConnectionId,
    t3EnvironmentId: row.t3EnvironmentId,
    t3ProjectId: row.t3ProjectId,
    t3ProjectTitle: row.t3ProjectTitle,
    worktreeBaseRef: row.worktreeBaseRef,
    targetBranch: row.targetBranch,
    startedStateId: row.startedStateId,
    startedStateName: row.startedStateName,
    enabled: row.enabled,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function GET() {
  try {
    const client = await ownerConvexClient();
    const rows = await client.action(api.projectMappings.list, {});
    return NextResponse.json({ mappings: rows.map(present) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}

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

function invalid(message: string) {
  return NextResponse.json(
    { error: { code: "invalid_request", message, retryable: false } },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return invalid("Send a JSON request.");
    }
    const body: unknown = await readBoundedJson(request, 8192);
    if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Send a JSON request.");
    const input = body as Record<string, unknown>;
    const textFields = [
      "linearWorkspaceId", "linearProjectId", "linearProjectName",
      "linearTeamId", "linearTeamKey", "linearTeamName",
      "t3ConnectionId", "t3EnvironmentId", "t3ProjectId", "t3ProjectTitle",
      "worktreeBaseRef", "targetBranch",
    ];
    for (const field of textFields) {
      if (typeof input[field] !== "string" || (input[field] as string).length === 0) {
        return invalid(`Mapping field ${field} is required.`);
      }
    }
    if (input.mappingId !== undefined && typeof input.mappingId !== "string") {
      return invalid("Mapping field mappingId is invalid.");
    }
    for (const field of ["startedStateId", "startedStateName"] as const) {
      if (input[field] !== undefined && typeof input[field] !== "string") {
        return invalid(`Mapping field ${field} is invalid.`);
      }
    }
    const client = await ownerConvexClient();
    const saved = await client.action(api.projectMappings.save, {
      ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId as never }),
      linearWorkspaceId: input.linearWorkspaceId as string,
      linearProjectId: input.linearProjectId as string,
      linearProjectName: input.linearProjectName as string,
      linearTeamId: input.linearTeamId as string,
      linearTeamKey: input.linearTeamKey as string,
      linearTeamName: input.linearTeamName as string,
      t3ConnectionId: input.t3ConnectionId as never,
      t3EnvironmentId: input.t3EnvironmentId as string,
      t3ProjectId: input.t3ProjectId as string,
      t3ProjectTitle: input.t3ProjectTitle as string,
      worktreeBaseRef: input.worktreeBaseRef as string,
      targetBranch: input.targetBranch as string,
      ...(input.startedStateId === undefined ? {} : { startedStateId: input.startedStateId as string }),
      ...(input.startedStateName === undefined ? {} : { startedStateName: input.startedStateName as string }),
    });
    return NextResponse.json({ mapping: present(saved) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: { "cache-control": "no-store" } });
  }
}
