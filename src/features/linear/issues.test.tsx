import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createLinearIssuesAdapter,
  decodeIssueRead,
  decodeIssuesPage,
  toIssueError,
  type FetchLike,
} from "./issues";
import { emptyFilters, IssuesBrowserView, issueListSummary, mergeIssues, resolveExecutionTarget } from "./IssuesPanel";
import type { ProjectMapping } from "./mappings";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const issueWire = {
  id: "issue-1",
  identifier: "EGA-680",
  title: "Browse real Linear issues",
  url: "https://linear.app/helm/issue/EGA-680",
  priority: 2,
  priorityLabel: "High",
  state: { id: "s-progress", name: "In Progress", type: "started" },
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  assignee: { id: "user-1", name: "Ada" },
  description: "Ship it.",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const pageWire = {
  items: [issueWire],
  nextCursor: "cursor-2",
  total: null,
  filtersEcho: {
    projectId: "proj-1", includeCompleted: false, stateType: null,
    priority: null, assigneeId: null, text: null, textScope: null, limit: 25,
  },
  freshness: { source: "linear", observedAt: "2026-10-18T00:00:00.000Z", stale: false },
  errors: [],
};

const mapping: ProjectMapping = {
  mappingId: "m-1",
  linearWorkspaceId: "ws-1",
  linearProjectId: "proj-1",
  linearProjectName: "Helm",
  linearTeamId: "team-eng",
  linearTeamKey: "ENG",
  linearTeamName: "Engineering",
  t3ConnectionId: "c-1",
  t3EnvironmentId: "env-1",
  t3ProjectId: "t3-proj-1",
  t3ProjectTitle: "Helm native",
  worktreeBaseRef: "refs/heads/main",
  targetBranch: "main",
  startedStateId: "s-1",
  startedStateName: "In Progress",
  enabled: true,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

describe("linear issues adapter", () => {
  it("decodes an issues page with every required list field", () => {
    const decoded = decodeIssuesPage(pageWire);
    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({
      identifier: "EGA-680",
      title: "Browse real Linear issues",
      url: "https://linear.app/helm/issue/EGA-680",
    });
    expect(decoded.nextCursor).toBe("cursor-2");
    expect(decoded.total).toBe(null);
    expect(decoded.errors).toEqual([]);
  });

  it("decodes a detail with acceptance criteria", () => {
    const decoded = decodeIssueRead({
      issue: { ...issueWire, acceptanceCriteria: "- [ ] List works" },
      freshness: pageWire.freshness,
      errors: ["Partial wobble"],
    });
    expect(decoded.issue.acceptanceCriteria).toBe("- [ ] List works");
    expect(decoded.errors).toEqual(["Partial wobble"]);
  });

  it("rejects a 2xx body that does not match the projection instead of emptying the list", () => {
    expect(() => decodeIssuesPage({ items: "nope" })).toThrow();
    expect(() => decodeIssuesPage({ ...pageWire, items: [{ ...issueWire, url: 42 }] })).toThrow();
  });

  it("maps a revoked grant to a distinct, non-retryable error", async () => {
    const fetchImpl: FetchLike = async () => response(502, {
      error: { code: "revoked", message: "Linear authorization was revoked. Reconnect to continue.", retryable: false },
    });
    const adapter = createLinearIssuesAdapter(fetchImpl);
    const failure = await adapter.browseIssues({ projectId: "proj-1" }).then(
      () => { throw new Error("expected browse to fail"); },
      (thrown) => toIssueError(thrown),
    );
    expect(failure.code).toBe("revoked");
    expect(failure.retryable).toBe(false);
  });

  it("maps rate limiting distinctly from a revoked grant", async () => {
    const fetchImpl: FetchLike = async () => response(429, {
      error: { code: "rate_limited", message: "Linear is receiving too many requests.", retryable: true },
    });
    const adapter = createLinearIssuesAdapter(fetchImpl);
    const failure = await adapter.browseIssues({ projectId: "proj-1" }).then(
      () => { throw new Error("expected browse to fail"); },
      (thrown) => toIssueError(thrown),
    );
    expect(failure.code).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
  });

  it("encodes browse filters as bounded query params", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (input) => {
      seen = String(input);
      return response(200, { ...pageWire, nextCursor: null });
    };
    const adapter = createLinearIssuesAdapter(fetchImpl);
    await adapter.browseIssues({
      projectId: "proj-1", includeCompleted: true, stateType: "started",
      priority: 1, assigneeId: "user-1", text: "browser", cursor: "cursor-1", limit: 10,
    });
    const params = new URL(seen, "https://helm.example").searchParams;
    expect(params.get("projectId")).toBe("proj-1");
    expect(params.get("includeCompleted")).toBe("true");
    expect(params.get("stateType")).toBe("started");
    expect(params.get("priority")).toBe("1");
    expect(params.get("assigneeId")).toBe("user-1");
    expect(params.get("text")).toBe("browser");
    expect(params.get("cursor")).toBe("cursor-1");
    expect(params.get("limit")).toBe("10");
  });
});

describe("issue browser view", () => {
  function viewProps(overrides: Record<string, unknown> = {}) {
    return {
      data: null,
      filters: { ...emptyFilters(), projectId: "proj-1" },
      mappings: [mapping],
      mappingsError: null,
      detail: null,
      notice: null,
      error: null,
      loading: false,
      loadingMore: false,
      detailLoading: false,
      detailError: null,
      onFilters: () => {},
      onSelectIssue: () => {},
      onLoadMore: () => {},
      ...overrides,
    } as Parameters<typeof IssuesBrowserView>[0];
  }

  it("merges follow-up pages without duplicating rows", () => {
    const first = decodeIssuesPage(pageWire).items;
    const merged = mergeIssues(first, [...first, { ...first[0]!, id: "issue-2" }]);
    expect(merged.map((item) => item.id)).toEqual(["issue-1", "issue-2"]);
  });

  it("summarizes loaded pages honestly, including loaded-page text scope", () => {
    const page = decodeIssuesPage(pageWire);
    expect(issueListSummary(page, 1)).toContain("More pages may exist upstream.");
    const done = decodeIssuesPage({ ...pageWire, nextCursor: null });
    expect(issueListSummary(done, 1)).toContain("End of the loaded pages.");
    const narrowed = decodeIssuesPage({
      ...pageWire,
      nextCursor: null,
      filtersEcho: { ...pageWire.filtersEcho, text: "browser", textScope: "loaded-page" },
    });
    expect(issueListSummary(narrowed, 1)).toContain("loaded pages only");
  });

  it("renders the issue list with source links and distinct partial-error copy", () => {
    const html = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      data: decodeIssuesPage({ ...pageWire, errors: ["Partial wobble"] }),
    })));
    expect(html).toContain("EGA-680");
    expect(html).toContain("Open in Linear");
    expect(html).toContain("https://linear.app/helm/issue/EGA-680");
    expect(html).toContain("may be partial");
  });

  it("renders an empty result as an honest empty page, never invented rows", () => {
    const html = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      data: decodeIssuesPage({ ...pageWire, items: [], nextCursor: null }),
    })));
    expect(html).toContain("empty page");
    expect(html).not.toContain("EGA-680");
  });

  it("renders the selected detail with description and acceptance criteria", () => {
    const read = decodeIssueRead({
      issue: { ...issueWire, acceptanceCriteria: "- [ ] List works" },
      freshness: pageWire.freshness,
      errors: [],
    });
    const html = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      data: decodeIssuesPage({ ...pageWire, nextCursor: null }),
      detail: { issue: read.issue, linearProjectId: "proj-1", stale: false },
    })));
    expect(html).toContain("Ship it.");
    expect(html).toContain("List works");
  });

  it("offers the execution review only for an issue with an enabled matching mapping", () => {
    const read = decodeIssueRead({ issue: issueWire, freshness: pageWire.freshness, errors: [] });
    const target = resolveExecutionTarget(
      { issue: read.issue, linearProjectId: "proj-1", stale: false },
      [mapping],
    );
    expect(target).toMatchObject({
      ok: true,
      linearProjectId: "proj-1",
      linearTeamId: "team-eng",
    });
    const html = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      detail: { issue: read.issue, linearProjectId: "proj-1", stale: false },
      executionTarget: target,
      executionArmed: false,
      onPrepareExecution: () => {},
    })));
    expect(html).toContain("Start work from this issue");
    expect(html).toMatch(/<button[^>]*>Prepare execution<\/button>/);
    expect(html).not.toContain("EXECUTION PANEL");

    const armed = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      detail: { issue: read.issue, linearProjectId: "proj-1", stale: false },
      executionTarget: target,
      executionArmed: true,
      onPrepareExecution: () => {},
      execution: createElement("div", null, "EXECUTION PANEL"),
    })));
    expect(armed).toContain("EXECUTION PANEL");
  });

  it("refuses execution when the mapping is disabled, for another team, or absent", () => {
    const read = decodeIssueRead({ issue: issueWire, freshness: pageWire.freshness, errors: [] });
    const detail = { issue: read.issue, linearProjectId: "proj-1", stale: false };

    expect(resolveExecutionTarget(detail, [{ ...mapping, enabled: false }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No enabled mapping"),
    });
    expect(resolveExecutionTarget(detail, [{ ...mapping, linearTeamId: "team-ops" }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No enabled mapping"),
    });
    expect(resolveExecutionTarget(detail, [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No enabled mapping"),
    });
    // The mapping must match the project the detail was actually READ from.
    expect(resolveExecutionTarget({ ...detail, linearProjectId: "proj-other" }, [mapping])).toMatchObject({
      ok: false,
    });
  });

  it("never arms execution for a stale detail or while mappings are loading", () => {
    const read = decodeIssueRead({ issue: issueWire, freshness: pageWire.freshness, errors: [] });
    expect(
      resolveExecutionTarget({ issue: read.issue, linearProjectId: "proj-1", stale: true }, [mapping]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("selection changed") });
    expect(resolveExecutionTarget({ issue: read.issue, linearProjectId: "proj-1", stale: false }, null)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Loading mapped projects"),
    });
    expect(resolveExecutionTarget(null, [mapping])).toBeNull();
  });

  it("renders the blocked reason and disables the prepare control", () => {
    const read = decodeIssueRead({ issue: issueWire, freshness: pageWire.freshness, errors: [] });
    const html = renderToStaticMarkup(createElement(IssuesBrowserView, viewProps({
      detail: { issue: read.issue, linearProjectId: "proj-1", stale: false },
      executionTarget: { ok: false, reason: "No enabled mapping covers this issue's Linear project and team; map it first." },
      executionArmed: false,
      onPrepareExecution: () => {},
    })));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare execution<\/button>/);
    expect(html).toContain("map it first");
  });
});
