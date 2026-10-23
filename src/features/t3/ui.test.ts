import { describe, expect, it } from "vitest";
import { connectionErrorLabel } from "./ui";

/**
 * Regression for the "Connection error: Unknown" display defect. A healthy
 * connected grant with no error must not claim an unknown error, and a real
 * reported code must never be disguised.
 */
describe("connectionErrorLabel", () => {
  it("shows a confirmed backend error code verbatim", () => {
    expect(connectionErrorLabel("revoked", "authorization_required")).toBe("authorization_required");
    expect(connectionErrorLabel("unreachable", "unreachable")).toBe("unreachable");
    expect(connectionErrorLabel("expired", "authorization_expired")).toBe("authorization_expired");
  });

  it("says there is no current error for a connected grant without a code", () => {
    expect(connectionErrorLabel("connected", null)).toBe("None — no current error");
    expect(connectionErrorLabel("connected", "")).toBe("None — no current error");
  });

  it("says the error was not reported when a non-connected grant has no code", () => {
    expect(connectionErrorLabel("unreachable", null)).toBe("Not reported by the backend");
    expect(connectionErrorLabel("disconnected", null)).toBe("Not reported by the backend");
    expect(connectionErrorLabel("expired", null)).toBe("Not reported by the backend");
  });

  it("never renders the word Unknown for the connection-error row", () => {
    for (const status of ["connected", "unreachable", "expired", "revoked", "disconnected"] as const) {
      expect(connectionErrorLabel(status, null)).not.toContain("Unknown");
      expect(connectionErrorLabel(status, "rate_limited")).not.toContain("Unknown");
    }
  });
});
