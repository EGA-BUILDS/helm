/** Small provider adapters with injected transports so checks remain testable without live services. */

export type AdapterResult = {
  ok: boolean;
  category: "missing_config" | "unauthorized" | "transport" | "timeout" | "wrong_identity" | "unsupported_response" | null;
  capabilities: string[];
  catalogObservedAt: number | null;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function failure(category: NonNullable<AdapterResult["category"]>): AdapterResult {
  return { ok: false, category, capabilities: [], catalogObservedAt: null };
}

/** Proves the configured Linear project is readable using only the isolated server key. */
export async function verifyLinearProject(input: {
  projectId: string;
  apiKey: string;
  fetcher?: FetchLike;
}): Promise<AdapterResult> {
  if (!input.projectId || !input.apiKey.trim()) return failure("missing_config");
  try {
    const response = await (input.fetcher ?? fetch)("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query HelmProjectCheck($id: String!) { viewer { id } project(id: $id) { id } }", variables: { id: input.projectId } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return failure("unauthorized");
    if (!response.ok) return failure("transport");
    let body: unknown;
    try { body = await response.json(); } catch { return failure("unsupported_response"); }
    if (typeof body !== "object" || body === null) return failure("unsupported_response");
    const data = (body as { data?: unknown }).data;
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) return failure("unsupported_response");
    if (typeof data !== "object" || data === null) return failure("unsupported_response");
    const viewer = (data as { viewer?: unknown }).viewer;
    const project = (data as { project?: unknown }).project;
    if (typeof viewer !== "object" || viewer === null || typeof (viewer as { id?: unknown }).id !== "string") return failure("unauthorized");
    if (typeof project !== "object" || project === null || (project as { id?: unknown }).id !== input.projectId) return failure("wrong_identity");
    return { ok: true, category: null, capabilities: ["linear.project.read"], catalogObservedAt: null };
  } catch (error) {
    return failure(error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? "timeout" : "transport");
  }
}

export type T3ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function textPayload(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return null;
  if ((response as { isError?: unknown }).isError === true) return null;
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content.find((item) => typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string") as { text: string } | undefined;
  if (!text) return null;
  try { return JSON.parse(text.text) as unknown; } catch { return null; }
}

/**
 * Requires explicit environment and project identity in the T3 project-list response.
 * Unknown response formats fail closed; a successful MCP handshake alone is not proof.
 */
export async function verifyT3Project(input: {
  environmentId: string;
  projectId: string;
  callTool: T3ToolCaller;
  observedAt?: number;
}): Promise<AdapterResult> {
  try {
    const capabilities = textPayload(await input.callTool("orchestrator_capabilities", {}));
    const environment = textPayload(await input.callTool("t3_environment_read", {}));
    const listed = textPayload(await input.callTool("t3_project_list", { limit: 50 }));
    if (capabilities === null || environment === null || listed === null) return failure("unsupported_response");
    if (
      typeof capabilities !== "object" || capabilities === null ||
      !Array.isArray((capabilities as { capabilities?: unknown }).capabilities)
    ) return failure("unsupported_response");
    const environmentId = typeof environment === "object" && environment !== null
      ? ((environment as { environmentId?: unknown }).environmentId ??
        (typeof (environment as { environment?: unknown }).environment === "object" && (environment as { environment: { id?: unknown } }).environment !== null
          ? (environment as { environment: { id?: unknown } }).environment.id
          : undefined))
      : undefined;
    if (environmentId !== input.environmentId) return failure("wrong_identity");
    const rows = Array.isArray(listed) ? listed : typeof listed === "object" && listed !== null && Array.isArray((listed as { projects?: unknown }).projects) ? (listed as { projects: unknown[] }).projects : null;
    if (!rows) return failure("unsupported_response");
    const matching = rows.filter((row) => {
      if (typeof row !== "object" || row === null) return false;
      const candidate = row as { projectId?: unknown; id?: unknown; environmentId?: unknown; environment?: unknown };
      const identifiers = [candidate.projectId, candidate.id].filter((value) => value !== undefined);
      if (identifiers.length === 0 || identifiers.some((value) => value !== input.projectId)) return false;
      if (candidate.environmentId !== undefined && candidate.environmentId !== input.environmentId) return false;
      if (candidate.environment !== undefined && candidate.environment !== input.environmentId) return false;
      return true;
    });
    if (matching.length !== 1) return failure("wrong_identity");
    const capabilityIds: string[] = [];
    for (const value of (capabilities as { capabilities: unknown[] }).capabilities) if (typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value)) capabilityIds.push(value);
    return {
      ok: true,
      category: null,
      capabilities: ["t3.project.read", ...capabilityIds.slice(0, 40)],
      catalogObservedAt: input.observedAt ?? Date.now(),
    };
  } catch (error) {
    return failure(error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? "timeout" : "transport");
  }
}
