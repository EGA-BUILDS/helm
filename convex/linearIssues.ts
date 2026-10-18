"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptLinearSecret, linearAccessPurpose } from "./lib/linearHelpers";
import {
  applyIssueTextFilter,
  buildIssueFilter,
  fetchLinearIssueDetail,
  fetchLinearIssuesPage,
  isLinearStateType,
} from "./lib/linearIssues";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const MAX_PROJECT_ID_LENGTH = 1024;
const MAX_TEXT_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2048;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

/**
 * Stored-OAuth token flow, identical in shape to `projectMappings.ts`
 * `linearAccessToken`: newest non-disconnected connection wins, expired and
 * revoked grants refuse with reconnect copy, and the workspace binding is
 * checked against the caller's mapped workspace before any GraphQL read.
 */
async function linearAccessToken(
  ctx: ActionCtx,
  owner: Owner,
  assertOwnerCurrent: () => Promise<unknown>,
  workspaceId?: string,
): Promise<{ token: string; workspaceId: string; workspaceName: string; workspaceUrlKey: string }> {
  const connections = await ctx.runQuery(internal.linearConnectionsStore.listConnections, {
    ...storeOwner(owner), now: Date.now(),
  });
  if (connections.length === 0) throw new Error("Linear connection is unavailable");
  const connection = connections[0]!;
  if (connection.status === "expired") {
    throw new Error("Linear connection has expired; reconnect it to continue");
  }
  if (connection.status === "reauthorizationRequired") {
    throw new Error("Linear authorization was revoked; reconnect to continue");
  }
  const secret = await ctx.runQuery(internal.linearConnectionsStore.getConnectionSecret, {
    ...storeOwner(owner), connectionId: connection.connectionId, now: Date.now(),
  });
  if (!secret) throw new Error("Linear connection is unavailable");
  if (workspaceId !== undefined && secret.workspaceId !== workspaceId) {
    throw new Error("Linear workspace identity changed; reconnect to confirm the workspace");
  }
  await assertOwnerCurrent();
  const token = decryptLinearSecret(
    secret.accessTokenCiphertext, linearAccessPurpose(owner.issuer, owner.subject, secret.workspaceId));
  return {
    token,
    workspaceId: secret.workspaceId,
    workspaceName: secret.workspaceName,
    workspaceUrlKey: secret.workspaceUrlKey,
  };
}

/**
 * Resolve the owner's enabled mappings for a client-supplied project id.
 * A project with no mapping — or only disabled mappings — is refused: the
 * caller can never browse an arbitrary project id.
 */
async function enabledMappingsForProject(ctx: ActionCtx, owner: Owner, projectId: string) {
  if (projectId.trim().length === 0 || projectId.length > MAX_PROJECT_ID_LENGTH) {
    throw new Error("Linear project is not available for browsing");
  }
  const mappings = await ctx.runQuery(internal.projectMappingsStore.enabledMappingsForProject, {
    ...storeOwner(owner), linearProjectId: projectId,
  });
  if (mappings.length === 0) throw new Error("Linear project is not available for browsing");
  return mappings;
}

const issueStateReturns = v.object({ id: v.string(), name: v.string(), type: v.string() });
const issueTeamReturns = v.object({ id: v.string(), key: v.string(), name: v.string() });
const issueAssigneeReturns = v.union(v.object({ id: v.string(), name: v.string() }), v.null());
const issueReturns = v.object({
  id: v.string(),
  identifier: v.string(),
  title: v.string(),
  url: v.string(),
  priority: v.number(),
  priorityLabel: v.string(),
  state: issueStateReturns,
  team: issueTeamReturns,
  assignee: issueAssigneeReturns,
  description: v.union(v.string(), v.null()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
type IssueView = Infer<typeof issueReturns>;

const filtersEchoReturns = v.object({
  projectId: v.string(),
  includeCompleted: v.boolean(),
  stateType: v.union(v.string(), v.null()),
  priority: v.union(v.number(), v.null()),
  assigneeId: v.union(v.string(), v.null()),
  text: v.union(v.string(), v.null()),
  /** Text narrowing covers loaded pages only — never invented completeness. */
  textScope: v.union(v.literal("loaded-page"), v.null()),
  limit: v.number(),
});

const freshnessReturns = v.object({
  source: v.literal("linear"),
  observedAt: v.string(),
  stale: v.boolean(),
});

const browseReturns = v.object({
  items: v.array(issueReturns),
  nextCursor: v.union(v.string(), v.null()),
  /** Linear reports no total for this connection: always null, never invented. */
  total: v.null(),
  filtersEcho: filtersEchoReturns,
  freshness: freshnessReturns,
  /** Upstream GraphQL errors that accompanied a usable page. Empty when clean. */
  errors: v.array(v.string()),
});

const browseArgs = {
  projectId: v.string(),
  includeCompleted: v.optional(v.boolean()),
  stateType: v.optional(v.string()),
  priority: v.optional(v.number()),
  assigneeId: v.optional(v.string()),
  text: v.optional(v.string()),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};

function checkedBrowseFilters(args: {
  includeCompleted?: boolean;
  stateType?: string;
  priority?: number;
  assigneeId?: string;
  text?: string;
  cursor?: string;
  limit?: number;
}) {
  const includeCompleted = args.includeCompleted ?? false;
  const stateType = args.stateType ?? null;
  if (stateType !== null && !isLinearStateType(stateType)) {
    throw new Error("Linear issue state filter is not supported");
  }
  const priority = args.priority ?? null;
  if (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 4)) {
    throw new Error("Linear issue priority filter is not supported");
  }
  const assigneeId = args.assigneeId ?? null;
  if (assigneeId !== null && (assigneeId.length < 1 || assigneeId.length > MAX_PROJECT_ID_LENGTH)) {
    throw new Error("Linear issue assignee filter is not supported");
  }
  const text = (args.text ?? "").trim();
  if (text.length > MAX_TEXT_LENGTH) throw new Error("Linear issue text filter is too long");
  const cursor = args.cursor ?? null;
  if (cursor !== null && (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH)) {
    throw new Error("Linear issue page cursor is invalid");
  }
  const limit = args.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error("Linear issue page size is not supported");
  }
  // Build the server filter now so an unsupported combination fails before
  // any network call.
  buildIssueFilter({
    includeCompleted,
    ...(stateType === null ? {} : { stateType }),
    ...(priority === null ? {} : { priority }),
    ...(assigneeId === null ? {} : { assigneeId }),
  });
  return { includeCompleted, stateType, priority, assigneeId, text, cursor, limit };
}

/**
 * Browse genuine Linear issues for one enabled mapped project. The project id
 * is resolved against the owner's enabled mappings — never trusted as an
 * arbitrary id. Server-side GraphQL filters where Linear supports them
 * (state type, priority, assignee); text narrows the loaded page and is
 * disclosed as `textScope: "loaded-page"`.
 */
export const browse = action({
  args: browseArgs,
  returns: browseReturns,
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const filters = checkedBrowseFilters(args);
    const mappings = await enabledMappingsForProject(ctx, owner, args.projectId);
    const linear = await linearAccessToken(ctx, owner, assertOwnerCurrent, mappings[0]!.linearWorkspaceId);
    await assertOwnerCurrent();
    const page = await fetchLinearIssuesPage(linear.token, {
      projectId: args.projectId,
      workspaceId: linear.workspaceId,
      first: filters.limit,
      ...(filters.cursor === null ? {} : { after: filters.cursor }),
      includeCompleted: filters.includeCompleted,
      ...(filters.stateType === null ? {} : { stateType: filters.stateType }),
      ...(filters.priority === null ? {} : { priority: filters.priority }),
      ...(filters.assigneeId === null ? {} : { assigneeId: filters.assigneeId }),
    });
    const textActive = filters.text.length > 0;
    const items: IssueView[] = textActive ? applyIssueTextFilter(page.items, filters.text) : page.items;
    return {
      items,
      nextCursor: page.nextCursor,
      total: null,
      filtersEcho: {
        projectId: args.projectId,
        includeCompleted: filters.includeCompleted,
        stateType: filters.stateType,
        priority: filters.priority,
        assigneeId: filters.assigneeId,
        text: textActive ? filters.text : null,
        textScope: textActive ? ("loaded-page" as const) : null,
        limit: filters.limit,
      },
      freshness: { source: "linear" as const, observedAt: new Date().toISOString(), stale: false },
      errors: page.errors,
    };
  },
});

const readReturns = v.object({
  issue: v.object({
    id: v.string(),
    identifier: v.string(),
    title: v.string(),
    url: v.string(),
    priority: v.number(),
    priorityLabel: v.string(),
    state: issueStateReturns,
    team: issueTeamReturns,
    assignee: issueAssigneeReturns,
    description: v.union(v.string(), v.null()),
    acceptanceCriteria: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }),
  freshness: freshnessReturns,
  errors: v.array(v.string()),
});

/**
 * Read one issue's full context (description plus acceptance criteria when
 * present) for an enabled mapped project. Same enabled-mapping check as
 * `browse`; the response project must match the request.
 */
export const read = action({
  args: { projectId: v.string(), issueId: v.string() },
  returns: readReturns,
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    if (args.issueId.trim().length === 0 || args.issueId.length > MAX_PROJECT_ID_LENGTH) {
      throw new Error("Linear issue is not available");
    }
    const mappings = await enabledMappingsForProject(ctx, owner, args.projectId);
    const linear = await linearAccessToken(ctx, owner, assertOwnerCurrent, mappings[0]!.linearWorkspaceId);
    await assertOwnerCurrent();
    const detail = await fetchLinearIssueDetail(linear.token, {
      projectId: args.projectId,
      workspaceId: linear.workspaceId,
      issueId: args.issueId,
    });
    return {
      issue: detail.issue,
      freshness: { source: "linear" as const, observedAt: new Date().toISOString(), stale: false },
      errors: detail.errors,
    };
  },
});
