"use node";

import {
  LINEAR_GRAPHQL_ENDPOINT,
  linearFetch,
  linearJson,
} from "./linearHelpers";

/**
 * Bounded Linear GraphQL reads for the owner issue browser (EGA-680).
 *
 * Pure parsers (`parseLinearIssuesPage`, `parseLinearIssueDetail`,
 * `buildIssueFilter`, `extractAcceptanceCriteria`, `applyIssueTextFilter`)
 * never touch the network and are unit tested without credentials. The thin
 * client (`fetchLinearIssuesPage`, `fetchLinearIssueDetail`) reuses the bounded
 * fetch/parse discipline from `linearHelpers` (`linearFetch`, `linearJson`)
 * and always authenticates with the **stored OAuth access token** — never a
 * `LINEAR_API_KEY`. No token is ever logged, returned, or persisted here; it
 * only travels in the Authorization header of the outbound request.
 *
 * Browse only: there is no mutation path in this module. Linear stays the
 * source of truth — no issue clone, no status write.
 */

export const LINEAR_ISSUES_PAGE_QUERY = `query($projectId: String!, $first: Int, $after: String, $filter: IssueFilter) {
  organization { id }
  project(id: $projectId) {
    id
    issues(first: $first, after: $after, filter: $filter) {
      nodes {
        id identifier title url priority priorityLabel description
        state { id name type }
        team { id key name }
        assignee { id name }
        createdAt updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const LINEAR_ISSUE_DETAIL_QUERY = `query($issueId: String!) {
  organization { id }
  issue(id: $issueId) {
    id identifier title url priority priorityLabel description
    state { id name type }
    team { id key name }
    project { id }
    assignee { id name }
    createdAt updatedAt
  }
}`;

/** Workflow state types Linear reports; the unfinished default excludes by type, never by name. */
export const LINEAR_UNFINISHED_EXCLUDED_TYPES = ["completed", "canceled"] as const;
const LINEAR_STATE_TYPES = new Set(["backlog", "unstarted", "started", "completed", "canceled", "triage"]);

export function isLinearStateType(value: string): boolean {
  return LINEAR_STATE_TYPES.has(value);
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

export interface LinearIssueAssignee {
  id: string;
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
  assignee: LinearIssueAssignee | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinearIssueDetail extends LinearIssue {
  /** Present only when the description actually contains an acceptance-criteria section; never fabricated. */
  acceptanceCriteria: string | null;
}

export interface LinearIssuesPage {
  items: LinearIssue[];
  nextCursor: string | null;
  /** Upstream GraphQL errors that accompanied a still-usable payload. Never a token. */
  errors: string[];
}

export interface LinearIssueRead {
  issue: LinearIssueDetail;
  errors: string[];
}

const MAX_ID_LENGTH = 1024;
const MAX_TEXT_LENGTH = 100_000;

function failClosed(reason: string): never {
  throw new Error(reason);
}

function requiredField(value: unknown, label: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    failClosed(`Linear issue read is unavailable (${label})`);
  }
  return value;
}

function optionalText(value: unknown, label: string, max = MAX_TEXT_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) {
    failClosed(`Linear issue read is unavailable (${label})`);
  }
  return value;
}

function requiredPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) {
    failClosed("Linear issue read is unavailable (priority)");
  }
  return value;
}

/** Sanitized upstream error text: control chars stripped, bounded, never a secret. */
function sanitizeUpstreamError(value: unknown): string {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).message
    : null;
  if (typeof raw !== "string") return "Linear reported an error";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "Linear reported an error";
  return cleaned.slice(0, 300);
}

/** GraphQL `errors` never hide a usable page, and never silently empty it: they ride along explicitly. */
function upstreamErrors(root: Record<string, unknown>): string[] {
  if (!Array.isArray(root.errors) || root.errors.length === 0) return [];
  return root.errors.map(sanitizeUpstreamError);
}

function dataNode(value: unknown, what: string): { data: Record<string, unknown>; errors: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed(`Linear issue read is unavailable (${what})`);
  }
  const root = value as Record<string, unknown>;
  const errors = upstreamErrors(root);
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    failClosed("Linear issue read is unavailable (payload)");
  }
  return { data: data as Record<string, unknown>, errors };
}

function checkWorkspace(
  data: Record<string, unknown>,
  expectedWorkspaceId: string | undefined,
): void {
  if (expectedWorkspaceId === undefined) return;
  const organization = data.organization;
  if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
    failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
  }
  if ((organization as Record<string, unknown>).id !== expectedWorkspaceId) {
    failClosed("Linear workspace identity changed; reconnect to confirm the workspace");
  }
}

function parseState(value: unknown): LinearIssueState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear issue read is unavailable (workflow state)");
  }
  const state = value as Record<string, unknown>;
  return {
    id: requiredField(state.id, "workflow state id"),
    name: requiredField(state.name, "workflow state name"),
    type: requiredField(state.type, "workflow state type"),
  };
}

function parseTeam(value: unknown): LinearIssueTeam {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear issue read is unavailable (team)");
  }
  const team = value as Record<string, unknown>;
  return {
    id: requiredField(team.id, "team id"),
    key: requiredField(team.key, "team key"),
    name: requiredField(team.name, "team name"),
  };
}

function parseAssignee(value: unknown): LinearIssueAssignee | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear issue read is unavailable (assignee)");
  }
  const assignee = value as Record<string, unknown>;
  return {
    id: requiredField(assignee.id, "assignee id"),
    name: requiredField(assignee.name, "assignee name"),
  };
}

function parseIssueNode(value: unknown): LinearIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failClosed("Linear issue read is unavailable (issue)");
  }
  const issue = value as Record<string, unknown>;
  return {
    id: requiredField(issue.id, "issue id"),
    identifier: requiredField(issue.identifier, "issue identifier"),
    title: requiredField(issue.title, "issue title", 10_000),
    url: requiredField(issue.url, "issue url", 4096),
    priority: requiredPriority(issue.priority),
    priorityLabel: requiredField(issue.priorityLabel, "priority label"),
    state: parseState(issue.state),
    team: parseTeam(issue.team),
    assignee: parseAssignee(issue.assignee),
    description: optionalText(issue.description, "issue description"),
    createdAt: requiredField(issue.createdAt, "issue createdAt"),
    updatedAt: requiredField(issue.updatedAt, "issue updatedAt"),
  };
}

/**
 * Parse one issues page. The response project must be the requested project
 * and (when bound) the response workspace must be the mapped workspace;
 * anything else fails closed rather than mixing projects across workspaces.
 * A null cursor is never treated as "more": `nextCursor` is non-null only
 * when Linear reports `hasNextPage` WITH a cursor.
 */
export function parseLinearIssuesPage(
  value: unknown,
  expectedProjectId: string,
  expectedWorkspaceId?: string,
): LinearIssuesPage {
  const { data, errors } = dataNode(value, "issues page");
  checkWorkspace(data, expectedWorkspaceId);
  const raw = data.project;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    failClosed("Linear project is unavailable");
  }
  const project = raw as Record<string, unknown>;
  if (project.id !== expectedProjectId) {
    failClosed("Linear returned a different project than requested");
  }
  const connection = project.issues;
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    failClosed("Linear issue read is unavailable (issues)");
  }
  const nodes = (connection as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) failClosed("Linear issue read is unavailable (issues)");
  const pageInfo = (connection as Record<string, unknown>).pageInfo;
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) {
    failClosed("Linear issue read is unavailable (page info)");
  }
  const info = pageInfo as Record<string, unknown>;
  if (typeof info.hasNextPage !== "boolean") {
    failClosed("Linear issue read is unavailable (page info)");
  }
  if (info.endCursor !== null && info.endCursor !== undefined &&
      (typeof info.endCursor !== "string" || info.endCursor.length === 0)) {
    failClosed("Linear issue read is unavailable (page info)");
  }
  const items = nodes.map(parseIssueNode);
  const nextCursor = info.hasNextPage && typeof info.endCursor === "string" && info.endCursor.length > 0
    ? info.endCursor
    : null;
  const pageErrors = [...errors];
  if (info.hasNextPage && nextCursor === null) {
    // Upstream claims more pages but supplied no cursor: say so explicitly
    // rather than silently presenting a partial page as complete.
    pageErrors.push("Linear reported further pages without a cursor; the list may be incomplete");
  }
  return { items, nextCursor, errors: pageErrors };
}

/**
 * Parse a single issue detail. Fails closed when the response issue belongs
 * to a different project (or workspace) than requested.
 */
export function parseLinearIssueDetail(
  value: unknown,
  expectedProjectId: string,
  expectedWorkspaceId?: string,
): LinearIssueRead {
  const { data, errors } = dataNode(value, "issue detail");
  checkWorkspace(data, expectedWorkspaceId);
  const issue = parseIssueNode(data.issue);
  const raw = data.issue as Record<string, unknown>;
  const project = raw.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    failClosed("Linear project is unavailable");
  }
  if ((project as Record<string, unknown>).id !== expectedProjectId) {
    failClosed("Linear returned a different project than requested");
  }
  return {
    issue: { ...issue, acceptanceCriteria: extractAcceptanceCriteria(issue.description) },
    errors,
  };
}

/**
 * Derive the acceptance-criteria section only when the description actually
 * contains an `## Acceptance criteria`-style heading. A description without
 * one yields null — never a fabricated section. Content runs until the next
 * markdown heading of any level or the end of the description.
 */
export function extractAcceptanceCriteria(description: string | null | undefined): string | null {
  if (typeof description !== "string" || description.length === 0) return null;
  const lines = description.split("\n");
  const heading = /^#{1,6}\s+acceptance\s+criteria\b.*$/iu;
  const anyHeading = /^#{1,6}\s+\S.*$/u;
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (anyHeading.test(line.trim())) break;
    body.push(line);
  }
  const section = body.join("\n").trim();
  return section.length > 0 ? section : null;
}

export interface IssueFilterOptions {
  includeCompleted: boolean;
  stateType?: string;
  priority?: number;
  assigneeId?: string;
}

/**
 * Server-side Linear `IssueFilter`. State filtering is by workflow state
 * `type`, never by state name: the unfinished default excludes the terminal
 * types `completed` and `canceled`; an explicit `stateType` overrides it.
 * Returns `undefined` when no server filter applies.
 */
export function buildIssueFilter(options: IssueFilterOptions): Record<string, unknown> | undefined {
  const clauses: Record<string, unknown>[] = [];
  if (options.stateType !== undefined) {
    if (!isLinearStateType(options.stateType)) {
      failClosed("Linear issue state filter is not supported");
    }
    clauses.push({ state: { type: { eq: options.stateType } } });
  } else if (!options.includeCompleted) {
    clauses.push({ state: { type: { nin: [...LINEAR_UNFINISHED_EXCLUDED_TYPES] } } });
  }
  if (options.priority !== undefined) {
    if (!Number.isInteger(options.priority) || options.priority < 0 || options.priority > 4) {
      failClosed("Linear issue priority filter is not supported");
    }
    clauses.push({ priority: { eq: options.priority } });
  }
  if (options.assigneeId !== undefined) {
    if (options.assigneeId.length < 1 || options.assigneeId.length > MAX_ID_LENGTH) {
      failClosed("Linear issue assignee filter is not supported");
    }
    clauses.push({ assignee: { id: { eq: options.assigneeId } } });
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

/**
 * Text narrowing over one loaded page (identifier, title, description).
 * Linear full-text search is not part of this read, so text NEVER fetches
 * further pages: callers must disclose `textScope: "loaded-page"` whenever
 * text actually narrowed the page.
 */
export function applyIssueTextFilter(items: LinearIssue[], text: string | undefined): LinearIssue[] {
  const needle = (text ?? "").trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) => {
    const haystacks = [item.identifier, item.title, item.description ?? ""];
    return haystacks.some((haystack) => haystack.toLowerCase().includes(needle));
  });
}

/** Bounded GraphQL POST authenticated with the stored OAuth access token. */
export async function requestLinearIssuesGraphql(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
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

export interface FetchIssuesPageArgs extends IssueFilterOptions {
  projectId: string;
  workspaceId: string;
  first: number;
  after?: string;
}

/** Live issues page for one mapped project, bound to its mapped workspace. */
export async function fetchLinearIssuesPage(
  accessToken: string,
  args: FetchIssuesPageArgs,
): Promise<LinearIssuesPage> {
  const filter = buildIssueFilter(args);
  return parseLinearIssuesPage(
    await requestLinearIssuesGraphql(accessToken, LINEAR_ISSUES_PAGE_QUERY, {
      projectId: args.projectId,
      first: args.first,
      ...(args.after === undefined ? {} : { after: args.after }),
      ...(filter === undefined ? {} : { filter }),
    }),
    args.projectId,
    args.workspaceId,
  );
}

/** Live issue detail, bound to the requested project and mapped workspace. */
export async function fetchLinearIssueDetail(
  accessToken: string,
  args: { projectId: string; workspaceId: string; issueId: string },
): Promise<LinearIssueRead> {
  return parseLinearIssueDetail(
    await requestLinearIssuesGraphql(accessToken, LINEAR_ISSUE_DETAIL_QUERY, { issueId: args.issueId }),
    args.projectId,
    args.workspaceId,
  );
}
