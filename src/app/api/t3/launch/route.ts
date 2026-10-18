import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { LAUNCH_KNOWN_MESSAGES } from "../../../../../convex/lib/launchErrors";
import { ownerConvexClient, requireSameOrigin, safeFailure } from "../../../../lib/t3Backend";

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
 * Owner-only native T3 launch (EGA-681 D07). Same-origin POST: validates the
 * reviewed launch fields, delegates to the operate-gated `api.t3Launch.launch`
 * action, and returns its outcome envelope. Domain outcomes (launched,
 * blocked, in_progress, ambiguous) are 200 envelopes — the same convention as
 * the execution preflight — so the owner always sees the exact reason.
 * Nothing here launches without an explicit owner POST; there is no GET that
 * launches and no ambient trigger.
 *
 * The GET handler below is the read-only attempt recovery (EGA-681
 * follow-up): it delegates to the owner-gated `api.t3Launch.recover` action
 * and returns its projection. Same-origin, bounded, read-only — no mutation,
 * relaunch, or reconciliation on this path. It lives in this route file
 * (rather than a sibling `attempt` route) so the deployment still ships
 * exactly one launch route.
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
    const text = (value: unknown, max: number): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
    const attemptId =
      typeof input.attemptId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input.attemptId) ? input.attemptId : null;
    const linearProjectId = text(input.linearProjectId, 1024);
    const linearTeamId = text(input.linearTeamId, 1024);
    const linearIssueId =
      typeof input.linearIssueId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input.linearIssueId)
        ? input.linearIssueId
        : null;
    const linearIssueIdentifier =
      typeof input.linearIssueIdentifier === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input.linearIssueIdentifier)
        ? input.linearIssueIdentifier
        : null;
    const prompt = text(input.prompt, 30000);
    const providerInstanceId = text(input.providerInstanceId, 256);
    const model = text(input.model, 256);
    const runtimeMode = text(input.runtimeMode, 64);
    if (!attemptId) return invalid("The launch request id is invalid.");
    if (!linearProjectId || !linearTeamId) {
      return invalid("Select a mapped Linear project and team to launch.");
    }
    if (!linearIssueId || !linearIssueIdentifier) {
      return invalid("Select a Linear issue to launch.");
    }
    if (!prompt) return invalid("The task prompt must not be empty.");
    if (!providerInstanceId || !model) return invalid("Choose a T3-advertised provider and model.");
    if (!runtimeMode) return invalid("A permission mode is required.");
    if (typeof input.useSubagents !== "boolean") return invalid("Send a JSON request.");
    if (input.subagentModel !== undefined && input.subagentModel !== null && typeof input.subagentModel !== "string") {
      return invalid("Send a JSON request.");
    }
    const subagentModel =
      typeof input.subagentModel === "string" && input.subagentModel.length > 0 ? input.subagentModel : undefined;
    if (subagentModel !== undefined && subagentModel.length > 256) return invalid("Send a JSON request.");
    const client = await ownerConvexClient();
    const result = await client.action(api.t3Launch.launch, {
      attemptId, linearProjectId, linearTeamId, linearIssueId, linearIssueIdentifier,
      prompt, providerInstanceId, model, runtimeMode,
      useSubagents: input.useSubagents,
      ...(subagentModel === undefined ? {} : { subagentModel }),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    // The launch action throws only fixed invalid-request sentences (see
    // convex/lib/launchErrors.ts); those are safe to repeat verbatim.
    if (error instanceof Error && (LAUNCH_KNOWN_MESSAGES as readonly string[]).includes(error.message)) {
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

const ISSUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function readRecoveryInput(input: Record<string, unknown>): {
  linearProjectId: string;
  linearTeamId: string;
  linearIssueId: string;
} | null {
  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
  };
  const linearProjectId = text(input.linearProjectId, 1024);
  const linearTeamId = text(input.linearTeamId, 1024);
  const linearIssueId =
    typeof input.linearIssueId === "string" && ISSUE_ID_PATTERN.test(input.linearIssueId)
      ? input.linearIssueId
      : null;
  if (!linearProjectId || !linearTeamId || !linearIssueId) return null;
  return { linearProjectId, linearTeamId, linearIssueId };
}

/**
 * Owner-gated, read-only attempt recovery. Same-origin GET: the execute panel
 * calls this on mount and whenever the issue/mapping identity changes, so a
 * hard reload recovers the server's attempt instead of minting a fresh id
 * from empty browser storage.
 *
 * Same-origin protection mirrors the launch POST: a present Origin must equal
 * the configured origin, otherwise the Referer must stay under it. A bare
 * navigation with neither header is refused — recovery is for same-origin
 * fetch, never for links. Input is bounded query params only.
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
    const input = readRecoveryInput({
      linearProjectId: url.searchParams.get("linearProjectId"),
      linearTeamId: url.searchParams.get("linearTeamId"),
      linearIssueId: url.searchParams.get("linearIssueId"),
    });
    if (!input) return invalid("Select a mapped Linear project, team, and issue to recover.");
    const client = await ownerConvexClient();
    return NextResponse.json(await client.action(api.t3Launch.recover, input), { headers: NO_STORE });
  } catch (error) {
    const failure = safeFailure(error);
    return NextResponse.json(
      { error: failure },
      { status: failure.code === "access_denied" ? 401 : 502, headers: NO_STORE },
    );
  }
}
