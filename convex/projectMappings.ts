"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { decryptLinearSecret, linearAccessPurpose } from "./lib/linearHelpers";
import {
  fetchLinearProjects,
  fetchLinearTeamStates,
  resolveStartedState,
} from "./lib/linearGraphql";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

const mappingViewReturns = v.object({
  mappingId: v.id("projectMappings"),
  linearWorkspaceId: v.string(),
  linearProjectId: v.string(),
  linearProjectName: v.string(),
  linearTeamId: v.string(),
  linearTeamKey: v.string(),
  linearTeamName: v.string(),
  t3ConnectionId: v.id("t3Connections"),
  t3EnvironmentId: v.string(),
  t3ProjectId: v.string(),
  t3ProjectTitle: v.string(),
  worktreeBaseRef: v.string(),
  targetBranch: v.string(),
  startedStateId: v.string(),
  startedStateName: v.string(),
  enabled: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
type MappingView = Infer<typeof mappingViewReturns>;

const candidateTeamReturns = v.object({
  teamId: v.string(),
  teamKey: v.string(),
  teamName: v.string(),
  startedStateId: v.union(v.string(), v.null()),
  startedStateName: v.union(v.string(), v.null()),
  stateError: v.union(v.string(), v.null()),
});

const candidatesReturns = v.object({
  workspace: v.object({ workspaceId: v.string(), workspaceName: v.string(), workspaceUrlKey: v.string() }),
  projects: v.array(v.object({
    projectId: v.string(),
    projectName: v.string(),
    teams: v.array(candidateTeamReturns),
  })),
  t3: v.object({
    connections: v.array(v.object({
      connectionId: v.id("t3Connections"),
      environmentId: v.string(),
      status: v.string(),
      projects: v.array(v.object({ projectId: v.string(), title: v.union(v.string(), v.null()) })),
      truncated: v.boolean(),
      error: v.union(v.string(), v.null()),
    })),
  }),
  truncated: v.boolean(),
});

/** At most this many (project, team) pairs are validated live per candidates call. */
const MAX_CANDIDATE_TEAMS = 100;
/** At most this many T3 projects are paged in per connection per candidates call. */
const MAX_T3_PROJECTS = 200;

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

export const list = action({
  args: {},
  returns: v.array(mappingViewReturns),
  handler: async (ctx): Promise<MappingView[]> => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    return await ctx.runQuery(internal.projectMappingsStore.listMappings, { ...storeOwner(owner) });
  },
});

export const candidates = action({
  args: {},
  returns: candidatesReturns,
  handler: async (ctx): Promise<Infer<typeof candidatesReturns>> => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const linear = await linearAccessToken(ctx, owner, assertOwnerCurrent);
    const projects = await fetchLinearProjects(linear.token, linear.workspaceId);

    const teamEntries: { projectId: string; projectName: string; teamId: string; teamKey: string; teamName: string }[] = [];
    for (const project of projects) {
      for (const team of project.teams) {
        teamEntries.push({
          projectId: project.id, projectName: project.name,
          teamId: team.id, teamKey: team.key, teamName: team.name,
        });
      }
    }
    const truncated = teamEntries.length > MAX_CANDIDATE_TEAMS;
    const validated = new Map<string, { startedStateId: string | null; startedStateName: string | null; stateError: string | null }>();
    for (const entry of teamEntries.slice(0, MAX_CANDIDATE_TEAMS)) {
      if (validated.has(entry.teamId)) continue;
      try {
        await assertOwnerCurrent();
        const { states } = await fetchLinearTeamStates(linear.token, entry.teamId, linear.workspaceId);
        const resolved = resolveStartedState(states, entry.teamKey);
        validated.set(entry.teamId, {
          startedStateId: resolved.id, startedStateName: resolved.name, stateError: null,
        });
      } catch (error) {
        validated.set(entry.teamId, {
          startedStateId: null, startedStateName: null,
          stateError: error instanceof Error ? error.message : "Linear team states are unavailable",
        });
      }
    }

    const t3Connections = await ctx.runQuery(internal.t3ConnectionsStore.listConnections, {
      ...storeOwner(owner), now: Date.now(),
    });
    const t3 = [];
    for (const connection of t3Connections) {
      if (connection.status !== "connected") {
        const error = connection.status === "expired"
          ? "T3 connection has expired; reconnect it to continue"
          : connection.status === "reauthorizationRequired"
            ? "T3 authorization was revoked; reconnect to continue"
            : "T3 connection is unreachable; refresh it before reading";
        t3.push({
          connectionId: connection.connectionId, environmentId: connection.environmentId,
          status: connection.status, projects: [], truncated: false, error,
        });
        continue;
      }
      try {
        await assertOwnerCurrent();
        const seen: { projectId: string; title: string | null }[] = [];
        let cursor: number | undefined = undefined;
        let truncatedProjects = false;
        for (;;) {
          const page = await ctx.runAction(api.t3OAuth.read, {
            connectionId: connection.connectionId,
            operation: "projects",
            input: { limit: 50, ...(cursor === undefined ? {} : { cursor }) },
          });
          if (!("items" in page)) throw new Error("T3 projects could not be read");
          for (const item of page.items) {
            if (!("projectId" in item)) throw new Error("T3 projects could not be read");
            seen.push({ projectId: String(item.projectId), title: "title" in item ? (item.title as string | null) : null });
            if (seen.length >= MAX_T3_PROJECTS) break;
          }
          const next = "nextCursor" in page ? page.nextCursor : null;
          if (seen.length >= MAX_T3_PROJECTS || next === null || next === undefined) {
            truncatedProjects = seen.length >= MAX_T3_PROJECTS && next !== null && next !== undefined;
            break;
          }
          cursor = next as number;
        }
        t3.push({
          connectionId: connection.connectionId, environmentId: connection.environmentId,
          status: connection.status, projects: seen, truncated: truncatedProjects, error: null,
        });
      } catch (error) {
        t3.push({
          connectionId: connection.connectionId, environmentId: connection.environmentId,
          status: connection.status, projects: [], truncated: false,
          error: error instanceof Error ? error.message : "T3 projects could not be read",
        });
      }
    }

    return {
      workspace: { workspaceId: linear.workspaceId, workspaceName: linear.workspaceName, workspaceUrlKey: linear.workspaceUrlKey },
      projects: projects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        teams: project.teams.map((team) => {
          const result = validated.get(team.id) ?? {
            startedStateId: null, startedStateName: null,
            stateError: "Too many teams to validate; narrow the Linear workspace",
          };
          return {
            teamId: team.id, teamKey: team.key, teamName: team.name,
            startedStateId: result.startedStateId,
            startedStateName: result.startedStateName,
            stateError: result.stateError,
          };
        }),
      })),
      t3: { connections: t3 },
      truncated,
    };
  },
});

const saveArgs = {
  mappingId: v.optional(v.id("projectMappings")),
  linearWorkspaceId: v.string(),
  linearProjectId: v.string(),
  linearProjectName: v.string(),
  linearTeamId: v.string(),
  linearTeamKey: v.string(),
  linearTeamName: v.string(),
  t3ConnectionId: v.id("t3Connections"),
  t3EnvironmentId: v.string(),
  t3ProjectId: v.string(),
  t3ProjectTitle: v.string(),
  worktreeBaseRef: v.string(),
  targetBranch: v.string(),
  startedStateId: v.optional(v.string()),
  startedStateName: v.optional(v.string()),
};

export const save = action({
  args: saveArgs,
  returns: mappingViewReturns,
  handler: async (ctx, args): Promise<MappingView> => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    // Shape checks fail before any network call: a missing destination must
    // never trigger a Linear read or a T3 read.
    if (args.linearProjectId.trim().length === 0 || args.linearTeamId.trim().length === 0) {
      throw new Error("Linear project mapping is missing its Linear destination");
    }
    if (args.t3ProjectId.trim().length === 0 || args.t3EnvironmentId.trim().length === 0) {
      throw new Error("Linear project mapping is missing its T3 destination");
    }
    if (args.worktreeBaseRef.trim().length === 0) {
      throw new Error("Linear project mapping is missing its worktree baseRef");
    }
    if (args.targetBranch.trim().length === 0) {
      throw new Error("Linear project mapping is missing its PR target branch");
    }

    // Linear side, validated live against the stored OAuth grant.
    const linear = await linearAccessToken(ctx, owner, assertOwnerCurrent, args.linearWorkspaceId);
    const projects = await fetchLinearProjects(linear.token, linear.workspaceId);
    const project = projects.find((entry) => entry.id === args.linearProjectId);
    if (!project) throw new Error("Linear project is no longer available");
    const team = project.teams.find((entry) => entry.id === args.linearTeamId);
    if (!team) throw new Error("Linear team is no longer available for this project");
    await assertOwnerCurrent();
    const { states } = await fetchLinearTeamStates(linear.token, args.linearTeamId, linear.workspaceId);
    const resolved = resolveStartedState(states, team.key);
    if (args.startedStateId !== undefined && args.startedStateId !== resolved.id) {
      throw new Error("Linear started state changed while saving; refresh the candidates");
    }
    if (args.startedStateName !== undefined && args.startedStateName !== resolved.name) {
      throw new Error("Linear started state changed while saving; refresh the candidates");
    }

    // T3 side, validated live through the existing T3 read path. This is a
    // read only: no status update, no worktree, no thread launch.
    const t3Connections = await ctx.runQuery(internal.t3ConnectionsStore.listConnections, {
      ...storeOwner(owner), now: Date.now(),
    });
    const t3Connection = t3Connections.find(
      (entry) => String(entry.connectionId) === String(args.t3ConnectionId),
    );
    if (!t3Connection) throw new Error("T3 destination is unavailable");
    if (t3Connection.status === "expired") {
      throw new Error("T3 connection has expired; reconnect it to continue");
    }
    if (t3Connection.status === "reauthorizationRequired") {
      throw new Error("T3 authorization was revoked; reconnect to continue");
    }
    if (t3Connection.status !== "connected") {
      throw new Error("T3 connection is unreachable; refresh it before reading");
    }
    await assertOwnerCurrent();
    const t3Project = await ctx.runAction(api.t3OAuth.read, {
      connectionId: t3Connection.connectionId,
      operation: "project",
      input: { projectId: args.t3ProjectId },
    });
    if (!("projectId" in t3Project) || t3Project.projectId !== args.t3ProjectId) {
      throw new Error("T3 destination is unavailable");
    }
    if (!("environmentId" in t3Project) || t3Project.environmentId !== args.t3EnvironmentId) {
      throw new Error("T3 environment identity changed; reconnect to confirm the endpoint");
    }
    // Prefer the live-verified title; the caller's label is only a fallback.
    const liveTitle = "title" in t3Project && typeof t3Project.title === "string" ? t3Project.title : null;

    const mappingId = await ctx.runMutation(internal.projectMappingsStore.saveMapping, {
      ...storeOwner(owner),
      ...(args.mappingId === undefined ? {} : { mappingId: args.mappingId }),
      linearWorkspaceId: linear.workspaceId,
      linearProjectId: project.id,
      linearProjectName: project.name,
      linearTeamId: team.id,
      linearTeamKey: team.key,
      linearTeamName: team.name,
      t3ConnectionId: t3Connection.connectionId,
      t3EnvironmentId: args.t3EnvironmentId,
      t3ProjectId: args.t3ProjectId,
      t3ProjectTitle: liveTitle ?? args.t3ProjectTitle,
      worktreeBaseRef: args.worktreeBaseRef,
      targetBranch: args.targetBranch,
      startedStateId: resolved.id,
      startedStateName: resolved.name,
      at: Date.now(),
    });
    const saved = await ctx.runQuery(internal.projectMappingsStore.getMapping, {
      ...storeOwner(owner), mappingId,
    });
    if (!saved) throw new Error("Project mapping is unavailable");
    return saved;
  },
});

export const disable = action({
  args: { mappingId: v.id("projectMappings") },
  returns: v.boolean(),
  handler: async (
    ctx,
    args,
  ): Promise<boolean> => {
    const owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    return await ctx.runMutation(internal.projectMappingsStore.disableMapping, {
      ...storeOwner(owner), mappingId: args.mappingId, at: Date.now(),
    });
  },
});
