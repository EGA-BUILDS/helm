import { NextResponse } from "next/server";
import { makeFunctionReference } from "convex/server";
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

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

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
    const projectId = text(input.projectId, 256);
    const threadId = text(input.threadId, 128);
    const linearProjectId = text(input.linearProjectId, 1024);
    const linearTeamId = text(input.linearTeamId, 1024);
    const linearIssueId = text(input.linearIssueId, 1024);
    const linearIssueIdentifier = text(input.linearIssueIdentifier ?? input.linearIssueId, 1024);
    if (!connectionId) return invalid("Select a T3 connection to link.");
    if (!projectId || !threadId) return invalid("Select a T3 thread to link.");
    if (!linearProjectId || !linearTeamId || !linearIssueId) {
      return invalid("Select a Linear issue to link.");
    }

    const linearWorkspaceId = text(input.linearWorkspaceId, 1024);
    const t3EnvironmentId = text(input.t3EnvironmentId, 1024);
    const t3ProjectId = text(input.t3ProjectId, 1024);
    const confirm = typeof input.confirm === "boolean" ? input.confirm : undefined;
    const confirmLaunchEvidenceLoss =
      typeof input.confirmLaunchEvidenceLoss === "boolean" ? input.confirmLaunchEvidenceLoss : undefined;
    const expectedAssociationId = text(input.expectedAssociationId, 1024);
    const note = text(input.note, 500);

    if ("linearWorkspaceId" in input && input.linearWorkspaceId !== undefined && linearWorkspaceId === null) {
      return invalid("Send a JSON request.");
    }
    if ("t3EnvironmentId" in input && input.t3EnvironmentId !== undefined && t3EnvironmentId === null) {
      return invalid("Send a JSON request.");
    }
    if ("confirm" in input && input.confirm !== undefined && typeof input.confirm !== "boolean") {
      return invalid("Send a JSON request.");
    }

    const client = await ownerConvexClient();
    const result = await client.action(makeFunctionReference<"action", Record<string, unknown>, unknown>("linearManualLink:link"), {
      connectionId,
      projectId,
      threadId,
      t3ThreadId: threadId,
      t3ProjectId: t3ProjectId ?? projectId,
      t3EnvironmentId: t3EnvironmentId ?? undefined,
      linearProjectId,
      linearTeamId,
      linearIssueId,
      linearIssueIdentifier: linearIssueIdentifier ?? linearIssueId,
      ...(linearWorkspaceId ? { linearWorkspaceId } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
      ...(confirmLaunchEvidenceLoss !== undefined ? { confirmLaunchEvidenceLoss } : {}),
      ...(expectedAssociationId ? { expectedAssociationId } : {}),
      ...(note ? { note } : {}),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    // Surface backend fixed messages (confirmation/conflict/launch evidence) verbatim.
    const message = error instanceof Error ? error.message : null;
    if (message && /confirmation|conflict|launch evidence|invalid/i.test(message)) {
      return NextResponse.json(
        { error: { code: "invalid_request", message, retryable: false } },
        { status: 400, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: failure },
      { status: failure.code === "access_denied" ? 401 : 502, headers: NO_STORE },
    );
  }
}
