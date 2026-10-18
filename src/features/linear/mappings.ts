/**
 * Same-origin HTTP adapter for the `/api/linear/mappings/*` route handlers.
 *
 * Every response is decoded exactly once here, at the transport boundary, so
 * the panel only ever sees the validated domain types below. A 2xx body that
 * does not match the known projection is treated as an error; it is never
 * downgraded into an empty successful list.
 *
 * No Clerk token is sent from the browser. The route handlers read the ambient
 * same-origin session and enforce the Convex owner grant themselves.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MappingError {
  code: string;
  message: string;
  retryable: boolean;
}

export class LinearMappingsRequestError extends Error {
  readonly mappingError: MappingError;

  constructor(mappingError: MappingError) {
    super(mappingError.message);
    this.name = "LinearMappingsRequestError";
    this.mappingError = mappingError;
  }
}

export function toMappingError(error: unknown): MappingError {
  if (error instanceof LinearMappingsRequestError) return error.mappingError;
  return { code: "unknown", message: "The project mappings request could not be completed.", retryable: true };
}

function fail(code: string, message: string, retryable = false): never {
  throw new LinearMappingsRequestError({ code, message, retryable });
}

function malformed(what: string): never {
  return fail("malformed_response", `Helm could not read ${what} from the mappings backend.`, true);
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

function flag(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : malformed(what);
}

export interface ProjectMapping {
  mappingId: string;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearProjectName: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  t3ConnectionId: string;
  t3EnvironmentId: string;
  t3ProjectId: string;
  t3ProjectTitle: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
  startedStateName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateStartedState {
  stateId: string;
  stateName: string;
}

export interface CandidateTeam {
  teamId: string;
  teamKey: string;
  teamName: string;
  /** Every usable started state the owner may choose between (never pre-picked by the server). */
  startedStates: CandidateStartedState[];
  /** Set only when the team has zero usable started states (or the read failed). */
  stateError: string | null;
}

export interface CandidateProject {
  projectId: string;
  projectName: string;
  teams: CandidateTeam[];
}

export interface CandidateT3Project {
  projectId: string;
  title: string | null;
}

export interface CandidateT3Connection {
  connectionId: string;
  environmentId: string;
  status: string;
  projects: CandidateT3Project[];
  truncated: boolean;
  error: string | null;
}

export interface MappingCandidates {
  workspace: { workspaceId: string; workspaceName: string; workspaceUrlKey: string };
  projects: CandidateProject[];
  t3: { connections: CandidateT3Connection[] };
  truncated: boolean;
}

/**
 * Selectors only. Every display name is resolved live by the backend and
 * stored from that read — the client never supplies labels, so a stale label
 * can never be stored. `startedStateId` is the owner's real selection.
 */
export interface MappingInput {
  mappingId?: string;
  linearWorkspaceId: string;
  linearProjectId: string;
  linearTeamId: string;
  t3ConnectionId: string;
  t3EnvironmentId: string;
  t3ProjectId: string;
  worktreeBaseRef: string;
  targetBranch: string;
  startedStateId: string;
}

const wireErrorMessages: Readonly<Partial<Record<string, string>>> = {
  access_denied: "Sign in with the Helm owner account to continue.",
  backend_unavailable: "Helm could not reach the mappings service.",
  invalid_request: "That mapping request was invalid. Check the highlighted fields.",
  not_found: "That project mapping no longer exists.",
  rate_limited: "Linear or T3 is receiving too many requests. Try again shortly.",
  misconfigured: "Helm's Linear connection service is not fully configured. An operator must finish setup.",
  origin_mismatch: "This Helm deployment is not configured for its own origin, so the request was refused.",
  unknown: "The project mappings request could not be completed.",
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) return malformed("a mappings result");
  return body;
}

export function decodeMapping(value: unknown): ProjectMapping {
  const raw = objectAt(value, "a project mapping");
  return {
    mappingId: text(raw.mappingId, "a mapping id"),
    linearWorkspaceId: text(raw.linearWorkspaceId, "a Linear workspace id"),
    linearProjectId: text(raw.linearProjectId, "a Linear project id"),
    linearProjectName: text(raw.linearProjectName, "a Linear project name"),
    linearTeamId: text(raw.linearTeamId, "a Linear team id"),
    linearTeamKey: text(raw.linearTeamKey, "a Linear team key"),
    linearTeamName: text(raw.linearTeamName, "a Linear team name"),
    t3ConnectionId: text(raw.t3ConnectionId, "a T3 connection id"),
    t3EnvironmentId: text(raw.t3EnvironmentId, "a T3 environment id"),
    t3ProjectId: text(raw.t3ProjectId, "a T3 project id"),
    t3ProjectTitle: text(raw.t3ProjectTitle, "a T3 project title"),
    worktreeBaseRef: text(raw.worktreeBaseRef, "a worktree baseRef"),
    targetBranch: text(raw.targetBranch, "a PR target branch"),
    startedStateId: text(raw.startedStateId, "a started workflow state"),
    startedStateName: text(raw.startedStateName, "a started workflow state name"),
    enabled: flag(raw.enabled, "a mapping enabled flag"),
    createdAt: text(raw.createdAt, "a mapping timestamp"),
    updatedAt: text(raw.updatedAt, "a mapping timestamp"),
  };
}

export function decodeCandidates(value: unknown): MappingCandidates {
  const raw = objectAt(value, "the mapping candidates");
  const workspace = objectAt(raw.workspace, "the Linear workspace");
  const projects = Array.isArray(raw.projects) ? raw.projects : malformed("the Linear project list");
  const t3 = objectAt(raw.t3, "the T3 inventory");
  const connections = Array.isArray(t3.connections) ? t3.connections : malformed("the T3 connection list");
  return {
    workspace: {
      workspaceId: text(workspace.workspaceId, "a Linear workspace id"),
      workspaceName: text(workspace.workspaceName, "a Linear workspace name"),
      workspaceUrlKey: text(workspace.workspaceUrlKey, "a Linear workspace key"),
    },
    projects: projects.map((entry) => {
      const project = objectAt(entry, "a Linear project");
      const teams = Array.isArray(project.teams) ? project.teams : malformed("a Linear team list");
      return {
        projectId: text(project.projectId, "a Linear project id"),
        projectName: text(project.projectName, "a Linear project name"),
        teams: teams.map((teamEntry) => {
          const team = objectAt(teamEntry, "a Linear team");
          const startedStates = Array.isArray(team.startedStates) ? team.startedStates : malformed("a started state list");
          return {
            teamId: text(team.teamId, "a Linear team id"),
            teamKey: text(team.teamKey, "a Linear team key"),
            teamName: text(team.teamName, "a Linear team name"),
            startedStates: startedStates.map((stateEntry) => {
              const state = objectAt(stateEntry, "a started workflow state");
              return {
                stateId: text(state.stateId, "a started workflow state id"),
                stateName: text(state.stateName, "a started workflow state name"),
              };
            }),
            stateError: optionalText(team.stateError, "a team state error"),
          };
        }),
      };
    }),
    t3: {
      connections: connections.map((entry) => {
        const connection = objectAt(entry, "a T3 connection");
        const items = Array.isArray(connection.projects) ? connection.projects : malformed("a T3 project list");
        return {
          connectionId: text(connection.connectionId, "a T3 connection id"),
          environmentId: text(connection.environmentId, "a T3 environment id"),
          status: text(connection.status, "a T3 connection status"),
          projects: items.map((item) => {
            const project = objectAt(item, "a T3 project");
            return { projectId: text(project.projectId, "a T3 project id"), title: optionalText(project.title, "a T3 project title") };
          }),
          truncated: flag(connection.truncated, "a T3 truncation flag"),
          error: optionalText(connection.error, "a T3 connection error"),
        };
      }),
    },
    truncated: flag(raw.truncated, "a candidates truncation flag"),
  };
}

export interface LinearMappingsAdapter {
  listMappings(signal?: AbortSignal): Promise<ProjectMapping[]>;
  loadCandidates(signal?: AbortSignal): Promise<MappingCandidates>;
  saveMapping(input: MappingInput, signal?: AbortSignal): Promise<ProjectMapping>;
  disableMapping(mappingId: string, signal?: AbortSignal): Promise<void>;
}

export function createLinearMappingsAdapter(fetchImpl?: FetchLike): LinearMappingsAdapter {
  const call: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async listMappings(signal) {
      const body = objectAt(
        await sendWith(call, "/api/linear/mappings", { method: "GET", signal }),
        "the mapping inventory",
      );
      return (Array.isArray(body.mappings) ? body.mappings : malformed("the mapping inventory")).map(decodeMapping);
    },
    async loadCandidates(signal) {
      return decodeCandidates(await sendWith(call, "/api/linear/mappings/candidates", { method: "GET", signal }));
    },
    async saveMapping(input, signal) {
      const body = objectAt(
        await sendWith(call, "/api/linear/mappings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(input), signal,
        }),
        "a saved mapping",
      );
      return decodeMapping(body.mapping);
    },
    async disableMapping(mappingId, signal) {
      await sendWith(call, `/api/linear/mappings/${encodeURIComponent(mappingId)}`, { method: "DELETE", signal });
    },
  };
}
