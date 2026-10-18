import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { linearStatus, ownerConvexClient, safeFailure } from "../../../../lib/linearBackend";

const NO_STORE = { "cache-control": "no-store" };
const MAX_TEXT_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2048;
const MAX_PAGE_SIZE = 50;

function invalid(message: string) {
  return NextResponse.json(
    { error: { code: "invalid_request", message, retryable: false } },
    { status: 400, headers: NO_STORE },
  );
}

function boundedText(value: string | null, max: number): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Browse genuine Linear issues for one enabled mapped project (EGA-680).
 * Owner-only: the Convex action resolves `projectId` against the owner's
 * enabled mappings and refuses any project that is not one. Read-only GET.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const projectId = boundedText(params.get("projectId"), 1024);
    if (!projectId) return invalid("Select a mapped Linear project to browse its issues.");

    const includeCompleted = params.get("includeCompleted") === "true";
    const stateType = boundedText(params.get("stateType"), 64);
    const priorityRaw = boundedText(params.get("priority"), 8);
    const assigneeId = boundedText(params.get("assigneeId"), 1024);
    const text = boundedText(params.get("text"), MAX_TEXT_LENGTH);
    const cursor = boundedText(params.get("cursor"), MAX_CURSOR_LENGTH);
    const limitRaw = boundedText(params.get("limit"), 8);

    let priority: number | undefined;
    if (priorityRaw !== undefined) {
      if (!/^[0-4]$/u.test(priorityRaw)) return invalid("Priority must be a number from 0 to 4.");
      priority = Number(priorityRaw);
    }
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (!/^\d{1,2}$/u.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_PAGE_SIZE) {
        return invalid(`Page size must be a number from 1 to ${MAX_PAGE_SIZE}.`);
      }
      limit = Number(limitRaw);
    }

    const client = await ownerConvexClient();
    const result = await client.action(api.linearIssues.browse, {
      projectId,
      includeCompleted,
      ...(stateType === undefined ? {} : { stateType }),
      ...(priority === undefined ? {} : { priority }),
      ...(assigneeId === undefined ? {} : { assigneeId }),
      ...(text === undefined ? {} : { text }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json({ error: failure }, { status: linearStatus(failure), headers: NO_STORE });
  }
}
