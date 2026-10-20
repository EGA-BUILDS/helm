import { describe, expect, it } from "vitest";
import { decodeAssociation, toManualLinkError } from "./manualLink";

/**
 * Cross-lane contract test for the EGA-763 backend's declared readAssociation
 * returns shape. The field list below is copied literally from the backend
 * action's declared returns — if the backend narrows or renames a field, this
 * test must fail before the UI silently breaks.
 */
describe("manualLink decodeAssociation contract", () => {
  it("decodes the backend's declared full durable row", () => {
    const backendRow = {
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
    };
    const decoded = decodeAssociation({ association: backendRow });
    expect(decoded).not.toBeNull();
    expect(decoded?.associationId).toBe("assoc-1");
    expect(decoded?.linearIssueIdentifier).toBe("EGA-763");
    expect(decoded?.t3EnvironmentId).toBe("env-1");
    expect(decoded?.t3ProjectId).toBe("t3-proj-1");
    expect(decoded?.t3ThreadId).toBe("mcp:thread-1");
    expect(decoded?.unlinkedAt).toBe(0);
    expect(decoded?.attemptId).toBe("");
    expect(decoded?.correlationKey).toBe("");
    expect(decoded?.provenance).toBe("manual");
    expect(decoded?.ledgerState).toBeNull();
  });

  it("decodes association: null as no association (unlinked)", () => {
    expect(decodeAssociation({ association: null })).toBeNull();
  });

  it("throws on a missing/invalid response rather than a blank association", () => {
    expect(() => decodeAssociation({ association: { associationId: "x" } })).toThrow();
    expect(() => decodeAssociation({ foo: "bar" })).toThrow();
  });

  it("toManualLinkError surfaces a read failure distinctly", () => {
    const err = toManualLinkError(new Error("boom"));
    expect(err.code).toBe("unknown");
  });
});
