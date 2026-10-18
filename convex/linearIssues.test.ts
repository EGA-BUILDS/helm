/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptLinearSecret, linearAccessPurpose, linearRefreshPurpose } from "./lib/linearHelpers";
import {
  applyIssueTextFilter,
  buildIssueFilter,
  extractAcceptanceCriteria,
  parseLinearIssueDetail,
  parseLinearIssuesPage,
} from "./lib/linearIssues";

/**
 * Owner issue browser contract (EGA-680).
 *
 * Pure parsers fail closed on GraphQL `errors` without data, on malformed
 * payloads, and on project/workspace mismatches; acceptance criteria are
 * derived only when the description actually contains them. The public
 * owner-gated actions resolve every project id against the owner's ENABLED
 * mappings, default to unfinished issues via a state-TYPE filter, and return
 * honest pagination (a null cursor is never "more").
 *
 * No live Linear connection: all network reads run against a stubbed fetch.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const owner = { subject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, revision: 1 };

const modules = import.meta.glob("./**/*.ts");
type Harness = ReturnType<typeof convexTest>;

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "EGA-680",
    title: "Browse real Linear issues",
    url: "https://linear.app/helm/issue/EGA-680",
    priority: 2,
    priorityLabel: "High",
    state: { id: "s-progress", name: "In Progress", type: "started" },
    team: { id: "team-eng", key: "ENG", name: "Engineering" },
    assignee: { id: "user-1", name: "Ada" },
    description: "Ship the browser.\n\n## Acceptance criteria\n\n- [ ] List works\n- [ ] Detail works\n\n## Notes\n\nLater.",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function pagePayload(overrides: {
  nodes?: unknown[];
  hasNextPage?: boolean;
  endCursor?: string | null;
  projectId?: string;
  workspaceId?: string;
  errors?: { message: string }[];
} = {}) {
  const { nodes, hasNextPage, endCursor, projectId, workspaceId, errors } = {
    nodes: [issueNode()],
    hasNextPage: false,
    endCursor: null,
    projectId: "proj-1",
    workspaceId: "ws-1",
    errors: undefined,
    ...overrides,
  };
  return {
    ...(errors === undefined ? {} : { errors }),
    data: {
      organization: { id: workspaceId },
      project: {
        id: projectId,
        issues: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

function detailPayload(overrides: { issue?: Record<string, unknown>; projectId?: string; workspaceId?: string } = {}) {
  const { issue, projectId, workspaceId } = { issue: issueNode(), projectId: "proj-1", workspaceId: "ws-1", ...overrides };
  return {
    data: {
      organization: { id: workspaceId },
      issue: { ...issue, project: { id: projectId } },
    },
  };
}

describe("linear issue parsers", () => {
  it("parses a full issues page with cursor and required fields", () => {
    const page = parseLinearIssuesPage(pagePayload(), "proj-1", "ws-1");
    expect(page.errors).toEqual([]);
    expect(page.nextCursor).toBe(null);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "issue-1",
      identifier: "EGA-680",
      title: "Browse real Linear issues",
      url: "https://linear.app/helm/issue/EGA-680",
      priority: 2,
      priorityLabel: "High",
      state: { id: "s-progress", name: "In Progress", type: "started" },
      team: { id: "team-eng", key: "ENG", name: "Engineering" },
      assignee: { id: "user-1", name: "Ada" },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("surfaces GraphQL 200-with-errors instead of hiding them or emptying the list", () => {
    const page = parseLinearIssuesPage(
      pagePayload({ errors: [{ message: "Something wobbled" }] }),
      "proj-1",
      "ws-1",
    );
    expect(page.items).toHaveLength(1);
    expect(page.errors).toEqual(["Something wobbled"]);
  });

  it("fails closed when errors accompany an unusable payload", () => {
    expect(() => parseLinearIssuesPage(
      { errors: [{ message: "boom" }], data: null },
      "proj-1",
      "ws-1",
    )).toThrow(/unavailable/);
  });

  it("respects upstream cursors and never treats a null cursor as more", () => {
    expect(parseLinearIssuesPage(
      pagePayload({ hasNextPage: true, endCursor: "cursor-2" }), "proj-1", "ws-1",
    ).nextCursor).toBe("cursor-2");
    expect(parseLinearIssuesPage(
      pagePayload({ hasNextPage: false, endCursor: null }), "proj-1", "ws-1",
    ).nextCursor).toBe(null);
    // Linear claims more pages but supplies no cursor: stop, and say so.
    const partial = parseLinearIssuesPage(
      pagePayload({ hasNextPage: true, endCursor: null }), "proj-1", "ws-1",
    );
    expect(partial.nextCursor).toBe(null);
    expect(partial.errors.length).toBeGreaterThan(0);
  });

  it("fails closed on a mismatched project or workspace", () => {
    expect(() => parseLinearIssuesPage(pagePayload({ projectId: "proj-other" }), "proj-1", "ws-1"))
      .toThrow(/different project/);
    expect(() => parseLinearIssuesPage(pagePayload({ workspaceId: "ws-other" }), "proj-1", "ws-1"))
      .toThrow(/workspace identity/);
  });

  it("fails closed on malformed payloads", () => {
    expect(() => parseLinearIssuesPage({ data: null }, "proj-1")).toThrow(/unavailable/);
    expect(() => parseLinearIssuesPage(pagePayload({ nodes: "nope" as never }), "proj-1"))
      .toThrow(/unavailable/);
    expect(() => parseLinearIssuesPage(
      pagePayload({ nodes: [issueNode({ priority: 9 })] }), "proj-1",
    )).toThrow(/unavailable/);
    expect(() => parseLinearIssuesPage(
      pagePayload({ nodes: [issueNode({ state: null })] }), "proj-1",
    )).toThrow(/unavailable/);
  });

  it("parses a detail and derives acceptance criteria only when present", () => {
    const read = parseLinearIssueDetail(detailPayload(), "proj-1", "ws-1");
    expect(read.errors).toEqual([]);
    expect(read.issue.identifier).toBe("EGA-680");
    expect(read.issue.acceptanceCriteria).toBe("- [ ] List works\n- [ ] Detail works");
  });

  it("yields no acceptance criteria when the description has none", () => {
    const read = parseLinearIssueDetail(
      detailPayload({ issue: issueNode({ description: "Just ship it." }) }), "proj-1", "ws-1",
    );
    expect(read.issue.acceptanceCriteria).toBe(null);
    const missing = parseLinearIssueDetail(
      detailPayload({ issue: issueNode({ description: null }) }), "proj-1", "ws-1",
    );
    expect(missing.issue.acceptanceCriteria).toBe(null);
  });

  it("fails closed when the detail belongs to a different project", () => {
    expect(() => parseLinearIssueDetail(detailPayload({ projectId: "proj-other" }), "proj-1", "ws-1"))
      .toThrow(/different project/);
  });

  it("extracts acceptance criteria across heading levels, never fabricating one", () => {
    expect(extractAcceptanceCriteria(null)).toBe(null);
    expect(extractAcceptanceCriteria("")).toBe(null);
    expect(extractAcceptanceCriteria("No heading here")).toBe(null);
    expect(extractAcceptanceCriteria("## Acceptance criteria\n")).toBe(null);
    expect(extractAcceptanceCriteria("### Acceptance Criteria\n\nDone when green.\n\n## Other\nx"))
      .toBe("Done when green.");
    // Section stops at the next heading of any level.
    expect(extractAcceptanceCriteria("# Title\n## acceptance criteria\nA\n# Next\nB")).toBe("A");
  });

  it("builds server filters by state type, never by state name", () => {
    // Unfinished default: terminal types excluded.
    expect(buildIssueFilter({ includeCompleted: false })).toEqual({
      state: { type: { nin: ["completed", "canceled"] } },
    });
    // Cleared: no state filter at all.
    expect(buildIssueFilter({ includeCompleted: true })).toBe(undefined);
    // Explicit type overrides the default.
    expect(buildIssueFilter({ includeCompleted: false, stateType: "completed" })).toEqual({
      state: { type: { eq: "completed" } },
    });
    expect(buildIssueFilter({ includeCompleted: true, priority: 1, assigneeId: "user-1" })).toEqual({
      and: [{ priority: { eq: 1 } }, { assignee: { id: { eq: "user-1" } } }],
    });
    expect(() => buildIssueFilter({ includeCompleted: false, stateType: "Done" })).toThrow(/not supported/);
    expect(() => buildIssueFilter({ includeCompleted: false, priority: 9 })).toThrow(/not supported/);
    expect(() => buildIssueFilter({ includeCompleted: false, assigneeId: "" })).toThrow(/not supported/);
  });

  it("narrows text over the loaded page only, case-insensitively", () => {
    const items = [
      issueNode({ id: "a", identifier: "EGA-1", title: "Alpha", description: "first" }),
      issueNode({ id: "b", identifier: "EGA-2", title: "Beta", description: "second" }),
    ].map((node) => parseLinearIssueDetail(
      { data: { issue: { ...node, project: { id: "proj-1" } } } }, "proj-1",
    ).issue);
    expect(applyIssueTextFilter(items, undefined)).toHaveLength(2);
    expect(applyIssueTextFilter(items, "  ")).toHaveLength(2);
    expect(applyIssueTextFilter(items, "ega-2").map((item) => item.id)).toEqual(["b"]);
    expect(applyIssueTextFilter(items, "ALPHA").map((item) => item.id)).toEqual(["a"]);
    expect(applyIssueTextFilter(items, "SECOND").map((item) => item.id)).toEqual(["b"]);
    expect(applyIssueTextFilter(items, "missing")).toHaveLength(0);
  });
});

describe("linear issue actions over stubbed Linear reads", () => {
  const LINEAR_KEY = Buffer.from("z".repeat(32)).toString("base64");
  let savedKeys: Record<string, string | undefined>;
  let savedOwner: Record<string, string | undefined>;
  let lastBodies: Record<string, unknown>[];

  beforeEach(() => {
    savedKeys = {
      LINEAR_OAUTH_ENCRYPTION_KEY_VERSION: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION,
      LINEAR_OAUTH_ENCRYPTION_KEY_V1: process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1,
      LINEAR_OAUTH_ENCRYPTION_KEY: process.env.LINEAR_OAUTH_ENCRYPTION_KEY,
    };
    savedOwner = {
      HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT,
      CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
    };
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_VERSION = "v1";
    process.env.LINEAR_OAUTH_ENCRYPTION_KEY_V1 = LINEAR_KEY;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    lastBodies = [];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries({ ...savedKeys, ...savedOwner })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  /** Stub Linear GraphQL: pages unless the body carries a cursor or an issue id. */
  function stubLinear(pages: (body: Record<string, unknown>) => unknown) {
    vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      lastBodies.push(body);
      return new Response(JSON.stringify(pages(body)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
  }

  async function granted() {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    return t;
  }

  async function seedLinearConnection(t: Harness, overrides: Record<string, unknown> = {}) {
    await t.run(async (ctx) => {
      await ctx.db.insert("linearConnections", {
        ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
        workspaceId: "ws-1", workspaceName: "Helm", workspaceUrlKey: "helm",
        accessTokenCiphertext: encryptLinearSecret("test-access-token", linearAccessPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
        refreshTokenCiphertext: encryptLinearSecret("test-refresh-token", linearRefreshPurpose(OWNER_ISSUER, OWNER_SUBJECT, "ws-1")),
        accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: null,
        credentialVersion: 1, scopes: ["read", "write"], status: "connected",
        lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
        clientId: "test-linear-client", redirectUri: "https://helm.example/api/linear/callback",
        createdAt: Date.now(), updatedAt: Date.now(),
        ...overrides,
      });
    });
  }

  async function seedEnabledMapping(t: Harness): Promise<void> {
    const t3ConnectionId = await t.run(async (ctx) => await ctx.db.insert("t3Connections", {
      ownerSubject: OWNER_SUBJECT, ownerIssuer: OWNER_ISSUER, ownerRevision: 1,
      endpoint: "https://studio.t3coderelay.com/mcp", issuer: "https://studio.t3coderelay.com",
      resource: "https://studio.t3coderelay.com/mcp", clientId: "helm-test-client",
      environmentId: "env-1", environmentLabel: "Studio", serverVersion: "1.0.0", platform: "linux/x64",
      access: "read-only", status: "connected", tokenCiphertext: "v1.token.placeholder.placeholder",
      credentialVersion: 1, expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(), updatedAt: Date.now(),
      lastVerifiedAt: null, lastSuccessfulReadAt: null, lastErrorCode: null,
    }));
    await t.mutation(internal.projectMappingsStore.saveMapping, {
      ...owner,
      linearWorkspaceId: "ws-1", linearProjectId: "proj-1", linearProjectName: "Helm",
      linearTeamId: "team-eng", linearTeamKey: "ENG", linearTeamName: "Engineering",
      t3ConnectionId, t3EnvironmentId: "env-1", t3ProjectId: "t3-proj-1", t3ProjectTitle: "Helm native",
      worktreeBaseRef: "refs/heads/main", targetBranch: "main",
      startedStateId: "state-started", startedStateName: "In Progress",
      at: Date.now(),
    });
  }

  async function disableMapping(t: Harness) {
    const rows = await t.run(async (ctx) => await ctx.db.query("linearProjectMappings").take(5));
    const id = rows[0]!._id as Id<"linearProjectMappings">;
    await t.mutation(internal.projectMappingsStore.disableMapping, { ...owner, mappingId: id, at: Date.now() });
  }

  it("denies anonymous and non-owner callers for both actions", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload());
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(t.action(api.linearIssues.browse, { projectId: "proj-1" })).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.linearIssues.read, { projectId: "proj-1", issueId: "issue-1" }))
      .rejects.toThrow(/unauthorized/);
    const other = t.withIdentity({ subject: "someone-else", issuer: OWNER_ISSUER });
    await expect(other.action(api.linearIssues.browse, { projectId: "proj-1" })).rejects.toThrow(/unauthorized/);
    await expect(other.action(api.linearIssues.read, { projectId: "proj-1", issueId: "issue-1" }))
      .rejects.toThrow(/unauthorized/);
    expect(authed).toBeDefined();
  });

  it("denies callers after the owner grant is revoked", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload());
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await expect(authed.action(api.linearIssues.browse, { projectId: "proj-1" })).rejects.toThrow(/unauthorized/);
    await expect(authed.action(api.linearIssues.read, { projectId: "proj-1", issueId: "issue-1" }))
      .rejects.toThrow(/unauthorized/);
  });

  it("refuses a project with no mapping and a project whose mapping is disabled", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload());
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(authed.action(api.linearIssues.browse, { projectId: "proj-unknown" }))
      .rejects.toThrow(/not available for browsing/);
    await expect(authed.action(api.linearIssues.read, { projectId: "proj-unknown", issueId: "issue-1" }))
      .rejects.toThrow(/not available for browsing/);
    await disableMapping(t);
    await expect(authed.action(api.linearIssues.browse, { projectId: "proj-1" }))
      .rejects.toThrow(/not available for browsing/);
  });

  it("browses an enabled mapping with the unfinished default and honest pagination", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload({ hasNextPage: true, endCursor: "cursor-2" }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed.action(api.linearIssues.browse, { projectId: "proj-1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.identifier).toBe("EGA-680");
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.total).toBe(null);
    expect(result.errors).toEqual([]);
    expect(result.filtersEcho).toMatchObject({
      projectId: "proj-1", includeCompleted: false, stateType: null, textScope: null,
    });
    expect(result.freshness.source).toBe("linear");
    // The unfinished default is a server-side state-TYPE filter.
    const variables = lastBodies[0]!.variables as Record<string, unknown>;
    expect(variables.filter).toEqual({ state: { type: { nin: ["completed", "canceled"] } } });
  });

  it("clears the unfinished filter and passes text through the loaded page only", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload({
      nodes: [
        issueNode({ id: "a", identifier: "EGA-1", title: "Alpha" }),
        issueNode({ id: "b", identifier: "EGA-2", title: "Beta" }),
      ],
    }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const cleared = await authed.action(api.linearIssues.browse, { projectId: "proj-1", includeCompleted: true });
    expect(cleared.items).toHaveLength(2);
    const clearedVariables = lastBodies.at(-1)!.variables as Record<string, unknown>;
    expect(clearedVariables.filter).toBe(undefined);
    const narrowed = await authed.action(api.linearIssues.browse, {
      projectId: "proj-1", includeCompleted: true, text: "beta",
    });
    expect(narrowed.items.map((item) => item.id)).toEqual(["b"]);
    expect(narrowed.filtersEcho.textScope).toBe("loaded-page");
    expect(narrowed.nextCursor).toBe(null);
  });

  it("surfaces partial GraphQL errors without silently returning an empty list", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload({ errors: [{ message: "Partial wobble" }] }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed.action(api.linearIssues.browse, { projectId: "proj-1" });
    expect(result.items).toHaveLength(1);
    expect(result.errors).toEqual(["Partial wobble"]);
  });

  it("fails closed when Linear answers for a different project", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => pagePayload({ projectId: "proj-other" }));
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    await expect(authed.action(api.linearIssues.browse, { projectId: "proj-1" }))
      .rejects.toThrow(/different project/);
  });

  it("reads an issue detail with description and acceptance criteria", async () => {
    const t = await granted();
    await seedLinearConnection(t);
    await seedEnabledMapping(t);
    stubLinear(() => detailPayload());
    const authed = t.withIdentity({ subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await authed.action(api.linearIssues.read, { projectId: "proj-1", issueId: "issue-1" });
    expect(result.issue.identifier).toBe("EGA-680");
    expect(result.issue.description).toContain("Ship the browser.");
    expect(result.issue.acceptanceCriteria).toBe("- [ ] List works\n- [ ] Detail works");
    expect(result.errors).toEqual([]);
  });
});
