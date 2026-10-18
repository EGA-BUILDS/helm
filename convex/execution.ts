"use node";

import { v, type Infer } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

type Owner = { subject: string; issuer: string; revision: number };
const storeOwner = (owner: Owner) => ({
  subject: owner.subject,
  ownerIssuer: owner.issuer,
  revision: owner.revision,
});

const catalogModel = v.object({
  id: v.string(),
  label: v.union(v.string(), v.null()),
});

const catalogProvider = v.object({
  providerInstanceId: v.string(),
  displayName: v.union(v.string(), v.null()),
  models: v.array(catalogModel),
});

const catalogSnapshot = v.object({
  providers: v.array(catalogProvider),
  runtimeMode: v.union(v.string(), v.null()),
  freshness: v.object({
    source: v.string(),
    observedAt: v.string(),
    stale: v.boolean(),
  }),
});

const preflightReturns = v.object({
  linearProjectId: v.string(),
  linearTeamId: v.string(),
  t3ConnectionId: v.union(v.string(), v.null()),
  t3EnvironmentId: v.union(v.string(), v.null()),
  t3ProjectId: v.union(v.string(), v.null()),
  t3ProjectTitle: v.union(v.string(), v.null()),
  worktreeBaseRef: v.union(v.string(), v.null()),
  targetBranch: v.union(v.string(), v.null()),
  startedStateId: v.union(v.string(), v.null()),
  catalog: v.union(catalogSnapshot, v.null()),
  catalogError: v.union(v.string(), v.null()),
  blockers: v.array(v.string()),
});

function sanitize(message: unknown): string {
  const raw = message instanceof Error ? message.message : "T3 catalog could not be read";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "T3 catalog could not be read";
  return cleaned.slice(0, 300);
}

function emptyVerdict(projectId: string, teamId: string, blockers: string[]) {
  return {
    linearProjectId: projectId,
    linearTeamId: teamId,
    t3ConnectionId: null as string | null,
    t3EnvironmentId: null as string | null,
    t3ProjectId: null as string | null,
    t3ProjectTitle: null as string | null,
    worktreeBaseRef: null as string | null,
    targetBranch: null as string | null,
    startedStateId: null as string | null,
    catalog: null as {
      providers: { providerInstanceId: string; displayName: string | null; models: { id: string; label: string | null }[] }[];
      runtimeMode: string | null;
      freshness: { source: string; observedAt: string; stale: boolean };
    } | null,
    catalogError: null as string | null,
    blockers,
  };
}

/**
 * Owner-gated execution preflight (EGA-761). Read-only: resolves the enabled
 * mapping for the (project, team) pair, re-checks the Linear grant and the T3
 * connection, then reads the T3 model catalog live through the existing
 * `api.t3OAuth.read` `capabilities` operation. Never launches anything: no T3
 * thread, no worktree, no Linear status write, no git operation.
 *
 * Every condition that must keep Execute disabled is reported as a
 * non-empty actionable `blockers` entry: missing/disabled mapping, revoked or
 * expired Linear grant, revoked or expired T3 connection, and a missing or
 * unreadable model catalog.
 *
 * Explicit annotations throughout (handler signature plus every
 * cross-module call result) work around the TypeScript circularity limit
 * noted in `convex/_generated/ai/guidelines.md`: without them the new
 * module's inferred type feeds back into the `api`/`internal` namespaces it
 * reads from and `tsc` gives up on this file and its neighbors.
 */
export const preflight = action({
  args: { linearProjectId: v.string(), linearTeamId: v.string() },
  returns: preflightReturns,
  handler: async (
    ctx: ActionCtx,
    args: { linearProjectId: string; linearTeamId: string },
  ): Promise<Infer<typeof preflightReturns>> => {
    const owner: Owner = await ctx.runQuery(internal.projectMappingsStore.ownerContext, {});
    const assertOwnerCurrent = () =>
      ctx.runQuery(internal.auth.assertCurrentGrant, {
        subject: owner.subject,
        issuer: owner.issuer,
        revision: owner.revision,
      });
    const projectId = args.linearProjectId;
    const teamId = args.linearTeamId;
    if (projectId.trim().length === 0 || projectId.length > 1024) {
      throw new Error("Linear project is not available for execution");
    }
    if (teamId.trim().length === 0 || teamId.length > 1024) {
      throw new Error("Linear team is not available for execution");
    }
    await assertOwnerCurrent();

    const mapping: {
      linearWorkspaceId: string;
      t3ConnectionId: Id<"t3Connections">;
      t3EnvironmentId: string;
      t3ProjectId: string;
      t3ProjectTitle: string;
      worktreeBaseRef: string;
      targetBranch: string;
      startedStateId: string;
    } | null = await ctx.runQuery(
      internal.projectMappingsStore.resolveMappingForIssue,
      { ...storeOwner(owner), linearProjectId: projectId, linearTeamId: teamId },
    );
    if (!mapping) {
      return emptyVerdict(projectId, teamId, [
        "No enabled mapping for this Linear project and team; map it first.",
      ]);
    }

    const blockers: string[] = [];

    // Linear grant re-check (read-only list; never decrypts or returns a token).
    const linearConnections: { workspaceId: string; status: string }[] = await ctx.runQuery(
      internal.linearConnectionsStore.listConnections,
      { ...storeOwner(owner), now: Date.now() },
    );
    const linear = linearConnections.find(
      (entry) => entry.workspaceId === mapping.linearWorkspaceId,
    ) ?? null;
    if (!linear) {
      blockers.push("Linear connection is unavailable; connect Linear to continue.");
    } else if (linear.status === "expired") {
      blockers.push("Linear connection has expired; reconnect it to continue.");
    } else if (linear.status === "reauthorizationRequired") {
      blockers.push("Linear authorization was revoked; reconnect to continue.");
    } else if (linear.status !== "connected") {
      blockers.push("Linear connection is not usable; reconnect it to continue.");
    }

    // T3 connection re-check (read-only list).
    const t3Connections: { connectionId: Id<"t3Connections">; status: string }[] =
      await ctx.runQuery(internal.t3ConnectionsStore.listConnections, {
        ...storeOwner(owner),
        now: Date.now(),
      });
    const t3 = t3Connections.find(
      (entry) => String(entry.connectionId) === String(mapping.t3ConnectionId),
    ) ?? null;
    if (!t3) {
      blockers.push("T3 destination is unavailable; remap the project to a live T3 connection.");
    } else if (t3.status === "expired") {
      blockers.push("T3 connection has expired; reconnect it to continue.");
    } else if (t3.status === "reauthorizationRequired") {
      blockers.push("T3 authorization was revoked; reconnect to continue.");
    } else if (t3.status !== "connected") {
      blockers.push("T3 connection is unreachable; refresh it before reading.");
    }

    const base = {
      linearProjectId: projectId,
      linearTeamId: teamId,
      t3ConnectionId: String(mapping.t3ConnectionId),
      t3EnvironmentId: mapping.t3EnvironmentId,
      t3ProjectId: mapping.t3ProjectId,
      t3ProjectTitle: mapping.t3ProjectTitle,
      worktreeBaseRef: mapping.worktreeBaseRef,
      targetBranch: mapping.targetBranch,
      startedStateId: mapping.startedStateId,
    };

    // Only a connected T3 destination gets a live catalog read. Anything else
    // already blocks Execute, and a read against a revoked/expired connection
    // would only repeat the actionable message above.
    if (!t3 || t3.status !== "connected") {
      return { ...base, catalog: null, catalogError: null, blockers };
    }

    await assertOwnerCurrent();
    try {
      // The live capabilities union is intentionally read through a narrow
      // structural view: the annotation keeps this module's inferred type
      // from feeding back into the `api` namespace (see the docstring
      // above), and the guards below fail closed on any shape change. The
      // extra optional members keep every union variant assignable to the
      // view; only `providers` is ever accepted as a catalog.
      const capabilities: {
        providers?: unknown;
        runtimeMode?: unknown;
        freshness?: unknown;
        environmentId?: unknown;
        items?: unknown;
        thread?: unknown;
        projectId?: unknown;
      } = await ctx.runAction(api.t3OAuth.read, {
          connectionId: mapping.t3ConnectionId,
          operation: "capabilities",
          input: {},
        });
      if (!Array.isArray(capabilities.providers)) {
        throw new Error("T3 catalog could not be read");
      }
      const providers: { providerInstanceId: string; displayName: string | null; models: { id: string; label: string | null }[] }[] =
        capabilities.providers.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("T3 catalog could not be read");
          }
          const provider = entry as Record<string, unknown>;
          if (typeof provider.providerInstanceId !== "string" || provider.providerInstanceId.length === 0) {
            throw new Error("T3 catalog could not be read");
          }
          if (!Array.isArray(provider.models)) throw new Error("T3 catalog could not be read");
          return {
            providerInstanceId: provider.providerInstanceId,
            displayName: typeof provider.displayName === "string" ? provider.displayName : null,
            models: provider.models.map((modelEntry) => {
              if (!modelEntry || typeof modelEntry !== "object" || Array.isArray(modelEntry)) {
                throw new Error("T3 catalog could not be read");
              }
              const model = modelEntry as Record<string, unknown>;
              if (typeof model.id !== "string" || model.id.length === 0) {
                throw new Error("T3 catalog could not be read");
              }
              return {
                id: model.id,
                label: typeof model.label === "string" ? model.label : null,
              };
            }),
          };
        });
      const freshnessRaw =
        capabilities.freshness && typeof capabilities.freshness === "object" && !Array.isArray(capabilities.freshness)
          ? (capabilities.freshness as Record<string, unknown>)
          : null;
      const freshness = {
        source: typeof freshnessRaw?.source === "string" ? freshnessRaw.source : "backend",
        observedAt:
          typeof freshnessRaw?.observedAt === "string"
            ? freshnessRaw.observedAt
            : new Date().toISOString(),
        stale: freshnessRaw?.stale === true,
      };
      const runtimeMode =
        typeof capabilities.runtimeMode === "string" ? capabilities.runtimeMode : null;
      const verdictBlockers = [...blockers];
      if (providers.length === 0 || providers.every((p) => p.models.length === 0)) {
        verdictBlockers.push(
          "No T3 providers or models are advertised; Execute stays disabled until the catalog lists one.",
        );
      }
      return {
        ...base,
        catalog: { providers, runtimeMode, freshness },
        catalogError: null,
        blockers: verdictBlockers,
      };
    } catch (error) {
      const reason = sanitize(error);
      return {
        ...base,
        catalog: null,
        catalogError: reason,
        blockers: [...blockers, `T3 catalog could not be read: ${reason}`],
      };
    }
  },
});
