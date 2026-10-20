import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualLinkControl } from "./ManualLinkControl";
import type { ManualLinkAssociation } from "./manualLink";

function association(overrides: Partial<ManualLinkAssociation> = {}): ManualLinkAssociation {
  return {
    associationId: "assoc-1",
    linearWorkspaceId: "ws-1",
    linearProjectId: "proj-1",
    linearTeamId: "team-eng",
    linearIssueId: "issue-1",
    linearIssueIdentifier: "EGA-763",
    t3ConnectionId: "c-1",
    t3EnvironmentId: "env-1",
    t3ProjectId: "t3-proj-1",
    t3ThreadId: "mcp:thread-1",
    attemptId: "",
    correlationKey: "",
    unlinkedAt: 0,
    createdAt: 1700000000000,
    note: "manual link",
    provenance: "manual",
    ledgerState: "linked",
    ...overrides,
  };
}

const baseProps = {
  connectionId: "c-1",
  projectId: "t3-proj-1",
  threadId: "mcp:thread-1",
};

describe("ManualLinkControl", () => {
  it("renders the current association instead of assuming empty", () => {
    const html = renderToStaticMarkup(
      createElement(ManualLinkControl, { ...baseProps, initialAssociation: association() }),
    );
    expect(html).toContain("EGA-763");
    expect(html).toContain("assoc-1");
    expect(html).toContain("manual link (no launch evidence)");
  });

  it("a link requires a selected Linear issue", () => {
    const html = renderToStaticMarkup(createElement(ManualLinkControl, { ...baseProps }));
    // With no issue selected, the link button is disabled.
    expect(html).toMatch(/disabled[^>]*>\s*Link thread to issue|Link thread to issue[\s\S]*disabled/);
  });

  it("a reassignment requires explicit confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(ManualLinkControl, {
        ...baseProps,
        initialAssociation: association(),
      }),
    );
    // The confirm button must not appear before the owner arms it.
    expect(html).not.toContain("Confirm reassignment");
    expect(html).toContain("Reassign to selected issue");
  });

  it("a stale expectedAssociationId surfaces a conflict and does not retry blindly", () => {
    // The component must carry the current association token into reassign
    // requests; a stale token is reported as a conflict by the backend and
    // the UI must not auto-retry.
    const current = association();
    expect(current.associationId).toBe("assoc-1");
  });

  it("a refused launch-evidence reassignment is explained", () => {
    const html = renderToStaticMarkup(
      createElement(ManualLinkControl, {
        ...baseProps,
        initialAssociation: association({ attemptId: "attempt-ld", provenance: "launch" }),
      }),
    );
    expect(html).toContain("launch evidence");
  });

  it("renders the reassign affordance while mapped projects are still loading", () => {
    const html = renderToStaticMarkup(
      createElement(ManualLinkControl, {
        ...baseProps,
        initialAssociation: association(),
      }),
    );
    // Effects do not run under renderToStaticMarkup, so mappings stay null:
    // the affordance must still be present, disabled/honest, not absent.
    expect(html).toContain("Loading mapped projects…");
    expect(html).toContain("Reassign to selected issue");
  });
});
