"use node";

import {
  LINEAR_GRAPHQL_ENDPOINT,
  linearFetch,
  linearJson,
} from "./linearHelpers";

/**
 * Bounded Linear GraphQL reads for project mappings (EGA-760).
 *
 * Pure parsers (`parseLinearProjects`, `parseLinearTeamStates`,
 * `resolveStartedState`) never touch the network and are unit tested without
 * credentials. The thin client (`requestLinearGraphql`,
 * `fetchLinearProjects`, `fetchLinearTeamStates`) reuses the bounded
 * fetch/parse discipline from `linearHelpers` (`linearFetch`, `linearJson`)
 * and always authenticates with the **stored OAuth access token** — never a
 * `LINEAR_API_KEY`. No token is ever logged, returned, or persisted here; it
 * only travels in the Authorization header of the outbound request.
 */

export const LINEAR_PROJECTS_QUERY =
  "query { organization { id } projects { nodes { id name teams { nodes { id key name } } } } }";

export const LINEAR_TEAM_STATES_QUERY =
  "query($teamId: String!) { team(id: $teamId) { id key name organization { id } states { nodes { id name type } } } }";

export interface LinearMappingTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearMappingProject {
  id: string;
  name: string;
  teams: LinearMappingTeam[];
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

const MAX_ID_LENGTH = 1024;

function requiredField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_LENGTH) {
    throw new Error(`Linear mapping read is unavailable (${label})`);
  }
  return value;
}

function failClosed(reason: string): never {
  throw new Error(reason);
}

function checkNoErrors(root: Record<string, unknown>): void {
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    failClosed("Linear mapping read reported errors");
  }
}

function dataNode(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear mapping read is unavailable (payload)");
  }
  const root = value as Record<string, unknown>;
  checkNoErrors(root);
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    failClosed("Linear mapping read is unavailable (payload)");
  }
  return data as Record<string, unknown>;
}

function nodesOf(value: unknown, label: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed(`Linear mapping read is unavailable (${label})`);
  }
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) failClosed(`Linear mapping read is unavailable (${label})`);
  return nodes;
}

function parseTeam(value: unknown): LinearMappingTeam {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear mapping read is unavailable (team)");
  }
  const team = value as Record<string, unknown>;
  return {
    id: requiredField(team.id, "team id"),
    key: requiredField(team.key, "team key"),
    name: requiredField(team.name, "team name"),
  };
}

function parseState(value: unknown): LinearWorkflowState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear mapping read is unavailable (workflow state)");
  }
  const state = value as Record<string, unknown>;
  return {
    id: requiredField(state.id, "workflow state id"),
    name: requiredField(state.name, "workflow state name"),
    type: requiredField(state.type, "workflow state type"),
  };
}

/**
 * Parse the project inventory. When `expectedWorkspaceId` is given, the
 * response's organization must match it, otherwise the read fails closed as a
 * wrong-workspace response rather than mixing projects across workspaces.
 */
export function parseLinearProjects(
  value: unknown,
  expectedWorkspaceId?: string,
): LinearMappingProject[] {
  const data = dataNode(value);
  if (expectedWorkspaceId !== undefined) {
    const organization = data.organization;
    if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
      failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
    }
    const workspaceId = (organization as Record<string, unknown>).id;
    if (workspaceId !== expectedWorkspaceId) {
      failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
    }
  }
  return nodesOf(data.projects, "projects").map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failClosed("Linear mapping read is unavailable (project)");
    }
    const project = entry as Record<string, unknown>;
    return {
      id: requiredField(project.id, "project id"),
      name: requiredField(project.name, "project name"),
      teams: nodesOf(project.teams, "project teams").map(parseTeam),
    };
  });
}

/** Parse a team's workflow states. The team id and workspace must match the request. */
export function parseLinearTeamStates(
  value: unknown,
  expectedTeamId: string,
  expectedWorkspaceId?: string,
): { team: LinearMappingTeam; states: LinearWorkflowState[] } {
  const data = dataNode(value);
  const raw = data.team;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    failClosed("Linear team is unavailable");
  }
  const teamRecord = raw as Record<string, unknown>;
  const team: LinearMappingTeam = {
    id: requiredField(teamRecord.id, "team id"),
    key: requiredField(teamRecord.key, "team key"),
    name: requiredField(teamRecord.name, "team name"),
  };
  if (team.id !== expectedTeamId) failClosed("Linear returned a different team than requested");
  if (expectedWorkspaceId !== undefined) {
    const organization = teamRecord.organization;
    if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
      failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
    }
    if ((organization as Record<string, unknown>).id !== expectedWorkspaceId) {
      failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
    }
  }
  return { team, states: nodesOf(teamRecord.states, "workflow states").map(parseState) };
}

/**
 * Every usable `type: "started"` candidate for a team. The owner chooses one;
 * the server never defaults, and never silently picks the first.
 */
export function startedStates(states: LinearWorkflowState[]): LinearWorkflowState[] {
  return states.filter((state) => state.type === "started");
}

/**
 * A structured configuration (not transport) failure of a started-state
 * resolution: the mapped started state is stale or the team has none. Callers
 * catch this type to classify the outcome as a CONFIGURATION stop instead of
 * matching message text with regex. The message stays the fixed sentence the
 * existing tests and call sites rely on.
 */
export class LinearMisconfiguration extends Error {}

/**
 * Validate the owner's chosen started state against a live read of that team.
 *
 * Fails closed with a specific reason: zero usable states, or a supplied id
 * that is not among this team's started states (unknown, stale, or never
 * started). The stored name always comes from the live read, never the caller.
 * Both failures throw `LinearMisconfiguration` so the sync path can classify
 * them as a configuration outcome, not a retryable network one.
 */
export function requireStartedState(
  states: LinearWorkflowState[],
  stateId: string,
  teamLabel: string,
): LinearWorkflowState {
  const usable = startedStates(states);
  if (usable.length === 0) {
    failConfigured(`Linear team ${teamLabel} has no started workflow state`);
  }
  const match = usable.find((state) => state.id === stateId);
  if (!match) {
    failConfigured(`Linear state ${stateId} is not a started workflow state for team ${teamLabel}`);
  }
  return match;
}

function failConfigured(reason: string): never {
  throw new LinearMisconfiguration(reason);
}

/** Bounded GraphQL POST authenticated with the stored OAuth access token. */
export async function requestLinearGraphql(
  accessToken: string,
  query: string,
  variables: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    failClosed("Linear connection is unavailable");
  }
  const response = await linearFetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  return linearJson(response);
}

/** Live project inventory for the connected workspace. */
export async function fetchLinearProjects(
  accessToken: string,
  workspaceId: string,
): Promise<LinearMappingProject[]> {
  return parseLinearProjects(
    await requestLinearGraphql(accessToken, LINEAR_PROJECTS_QUERY, {}),
    workspaceId,
  );
}

/** Live workflow states for one team, with the workspace binding re-checked. */
export async function fetchLinearTeamStates(
  accessToken: string,
  teamId: string,
  workspaceId: string,
): Promise<{ team: LinearMappingTeam; states: LinearWorkflowState[] }> {
  return parseLinearTeamStates(
    await requestLinearGraphql(accessToken, LINEAR_TEAM_STATES_QUERY, { teamId }),
    teamId,
    workspaceId,
  );
}
