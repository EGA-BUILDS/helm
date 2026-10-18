/**
 * Same-origin HTTP adapter for the `/api/linear/issues/*` route handlers.
 *
 * Every response is decoded exactly once here, at the transport boundary, so
 * the panel only ever sees the validated domain types below. A 2xx body that
 * does not match the known projection is treated as an error; it is never
 * downgraded into an empty successful list.
 *
 * Browse only: this adapter never writes a Linear issue, changes a status, or
 * launches anything. No Clerk token is sent from the browser. The route
 * handlers read the ambient same-origin session and enforce the Convex owner
 * grant themselves.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IssueError {
  code: string;
  message: string;
  retryable: boolean;
}

export class LinearIssuesRequestError extends Error {
  readonly issueError: IssueError;

  constructor(issueError: IssueError) {
    super(issueError.message);
    this.name = "LinearIssuesRequestError";
    this.issueError = issueError;
  }
}

export function toIssueError(error: unknown): IssueError {
  if (error instanceof LinearIssuesRequestError) return error.issueError;
  return { code: "unknown", message: "The Linear issue request could not be completed.", retryable: true };
}

function fail(code: string, message: string, retryable = false): never {
  throw new LinearIssuesRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the issue backend.`, true);
}

type Json = Record<string, unknown>;

function objectAt(value: unknown, what: string): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : malformed(what);
}

function text(value: unknown, what: string): string {
  return typeof value === "string" && value.length > 0 ? value : malformed(what);
}

function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : malformed(what);
}

function optionalNumber(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : malformed(what);
}

function flag(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : malformed(what);
}

export interface LinearIssueState {
  id: string;
  name: string;
  type: string;
}

export interface LinearIssueTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  state: LinearIssueState;
  team: LinearIssueTeam;
  assignee: { id: string; name: string } | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinearIssueDetail extends LinearIssue {
  acceptanceCriteria: string | null;
}

export interface IssueFiltersEcho {
  projectId: string;
  includeCompleted: boolean;
  stateType: string | null;
  priority: number | null;
  assigneeId: string | null;
  text: string | null;
  /** Text narrowing covers loaded pages only — never invented completeness. */
  textScope: "loaded-page" | null;
  limit: number;
}

export interface IssueFreshness {
  source: string;
  observedAt: string;
  stale: boolean;
}

export interface IssuesPage {
  items: LinearIssue[];
  nextCursor: string | null;
  /** Linear reports no total for this connection: always null, never invented. */
  total: null;
  filtersEcho: IssueFiltersEcho;
  freshness: IssueFreshness;
  /** Upstream GraphQL errors that accompanied a usable page. Empty when clean. */
  errors: string[];
}

export interface IssueRead {
  issue: LinearIssueDetail;
  freshness: IssueFreshness;
  errors: string[];
}

export interface BrowseIssuesInput {
  projectId: string;
  includeCompleted?: boolean;
  stateType?: string;
  priority?: number;
  assigneeId?: string;
  text?: string;
  cursor?: string;
  limit?: number;
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the issue service.",
  invalid_request: "That issue request was invalid. Check the filters.",
  not_found: "That Linear issue no longer exists.",
  revoked: "Linear authorization was revoked. Reconnect to continue.",
  connection_expired: "This Linear authorization expired. Reconnect to continue.",
  rate_limited: "Linear is receiving too many requests. Try again shortly.",
  misconfigured: "Helm's Linear connection service is not fully configured. An operator must finish setup.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The Linear issue request could not be completed.",
};

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 300 ? cleaned : null;
}

async function sendWith(call: FetchLike, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await call(path, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    return fail("backend_unavailable", wireErrorMessages.backend_unavailable!, true);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const wire = typeof body === "object" && body !== null && !Array.isArray(body)
      ? ((body as Json).error as Json | undefined)
      : undefined;
    const code = typeof wire?.code === "string" ? wire.code : response.status === 401 ? "access_denied" : "unknown";
    const message = sanitizeMessage(wire?.message) ?? wireErrorMessages[code] ?? wireErrorMessages.unknown!;
    const retryable = code === "backend_unavailable" || code === "rate_limited" || code === "unknown";
    return fail(code, message, retryable);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return malformed("an issue result");
  return body;
}

function decodeAssignee(value: unknown): LinearIssue["assignee"] {
  if (value === null || value === undefined) return null;
  const raw = objectAt(value, "an issue assignee");
  return { id: text(raw.id, "an assignee id"), name: text(raw.name, "an assignee name") };
}

export function decodeIssue(value: unknown): LinearIssue {
  const raw = objectAt(value, "a Linear issue");
  const state = objectAt(raw.state, "an issue state");
  const team = objectAt(raw.team, "an issue team");
  const priority = raw.priority;
  if (typeof priority !== "number") malformed("an issue priority");
  return {
    id: text(raw.id, "an issue id"),
    identifier: text(raw.identifier, "an issue identifier"),
    title: text(raw.title, "an issue title"),
    url: text(raw.url, "an issue URL"),
    priority,
    priorityLabel: text(raw.priorityLabel, "an issue priority label"),
    state: {
      id: text(state.id, "a state id"),
      name: text(state.name, "a state name"),
      type: text(state.type, "a state type"),
    },
    team: {
      id: text(team.id, "a team id"),
      key: text(team.key, "a team key"),
      name: text(team.name, "a team name"),
    },
    assignee: decodeAssignee(raw.assignee),
    description: optionalText(raw.description, "an issue description"),
    createdAt: text(raw.createdAt, "an issue timestamp"),
    updatedAt: text(raw.updatedAt, "an issue timestamp"),
  };
}

function decodeFreshness(value: unknown): IssueFreshness {
  const raw = objectAt(value, "an issue freshness marker");
  return {
    source: text(raw.source, "a freshness source"),
    observedAt: text(raw.observedAt, "a freshness timestamp"),
    stale: flag(raw.stale, "a freshness flag"),
  };
}

function decodeFiltersEcho(value: unknown): IssueFiltersEcho {
  const raw = objectAt(value, "the echoed filters");
  const textScope = raw.textScope;
  if (textScope !== null && textScope !== "loaded-page") malformed("the echoed text scope");
  return {
    projectId: text(raw.projectId, "the echoed project id"),
    includeCompleted: flag(raw.includeCompleted, "the echoed unfinished filter"),
    stateType: optionalText(raw.stateType, "the echoed state filter"),
    priority: optionalNumber(raw.priority, "the echoed priority filter"),
    assigneeId: optionalText(raw.assigneeId, "the echoed assignee filter"),
    text: optionalText(raw.text, "the echoed text filter"),
    textScope,
    limit: typeof raw.limit === "number" ? raw.limit : malformed("the echoed page size"),
  };
}

function decodeErrors(value: unknown): string[] {
  if (!Array.isArray(value)) malformed("the issue error list");
  return value.map((entry) => (typeof entry === "string" ? entry : malformed("the issue error list")));
}

export function decodeIssuesPage(value: unknown): IssuesPage {
  const raw = objectAt(value, "the Linear issue list");
  const items = Array.isArray(raw.items) ? raw.items : malformed("the Linear issue list");
  const nextCursor = raw.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") malformed("the Linear page cursor");
  if (raw.total !== null && raw.total !== undefined) malformed("the Linear issue total");
  return {
    items: items.map(decodeIssue),
    nextCursor,
    total: null,
    filtersEcho: decodeFiltersEcho(raw.filtersEcho),
    freshness: decodeFreshness(raw.freshness),
    errors: decodeErrors(raw.errors),
  };
}

export function decodeIssueRead(value: unknown): IssueRead {
  const raw = objectAt(value, "the Linear issue detail");
  const issue = decodeIssue(raw.issue);
  const acceptanceCriteria = optionalText(
    (objectAt(raw.issue, "the Linear issue detail") as Json).acceptanceCriteria,
    "the acceptance criteria",
  );
  return {
    issue: { ...issue, acceptanceCriteria },
    freshness: decodeFreshness(raw.freshness),
    errors: decodeErrors(raw.errors),
  };
}

function browseQuery(input: BrowseIssuesInput): string {
  const params = new URLSearchParams({ projectId: input.projectId });
  if (input.includeCompleted) params.set("includeCompleted", "true");
  if (input.stateType) params.set("stateType", input.stateType);
  if (input.priority !== undefined) params.set("priority", String(input.priority));
  if (input.assigneeId) params.set("assigneeId", input.assigneeId);
  if (input.text) params.set("text", input.text);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return `/api/linear/issues?${params.toString()}`;
}

export interface LinearIssuesAdapter {
  browseIssues(input: BrowseIssuesInput, signal?: AbortSignal): Promise<IssuesPage>;
  readIssue(projectId: string, issueId: string, signal?: AbortSignal): Promise<IssueRead>;
}

export function createLinearIssuesAdapter(fetchImpl?: FetchLike): LinearIssuesAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async browseIssues(input, signal) {
      const body = await sendWith(call, browseQuery(input), { method: "GET", signal });
      return decodeIssuesPage(body);
    },
    async readIssue(projectId, issueId, signal) {
      const path = `/api/linear/issues/${encodeURIComponent(issueId)}?projectId=${encodeURIComponent(projectId)}`;
      const body = objectAt(await sendWith(call, path, { method: "GET", signal }), "the Linear issue detail");
      return decodeIssueRead(body);
    },
  };
}
