import { describe, expect, it } from "vitest";
import {
  OPERATE_REFUSAL_DETAIL,
  assertOperateEnvironment,
  resolveOperateConnection,
  type OperateConnectionRow,
} from "./operateGate";

/**
 * Exhaustive unit coverage of the shared operate gate.
 *
 * This decision is the boundary between a read-only credential and a native
 * write, so every branch is asserted explicitly rather than sampled.
 */

const row = (over: Partial<OperateConnectionRow> = {}): OperateConnectionRow => ({
  connectionId: "conn_operate",
  access: "operate",
  status: "connected",
  environmentId: "env_1",
  ...over,
});

describe("resolveOperateConnection", () => {
  it("selects the single usable operate connection", () => {
    expect(resolveOperateConnection([row()])).toEqual({
      ok: true,
      connectionId: "conn_operate",
      environmentId: "env_1",
    });
  });

  it("never selects a read-only connection, even when it is the only one", () => {
    const verdict = resolveOperateConnection([row({ access: "read-only" })]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_not_granted");
  });

  it("never selects a legacy/unknown access value", () => {
    for (const access of ["", "operate ", "OPERATE", "full-access", "read_only"]) {
      const verdict = resolveOperateConnection([row({ access })]);
      expect(verdict.ok, `access ${JSON.stringify(access)} must not satisfy the gate`).toBe(false);
    }
  });

  it("refuses when there is no operate grant at all", () => {
    const verdict = resolveOperateConnection([]);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_not_granted");
  });

  it("refuses an ambiguous operate inventory rather than picking one", () => {
    const verdict = resolveOperateConnection([row(), row({ connectionId: "conn_2" })]);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_ambiguous");
  });

  it("reports ambiguity before usability, so identity is fixed first", () => {
    const verdict = resolveOperateConnection([
      row({ status: "expired" }),
      row({ connectionId: "conn_2", status: "connected" }),
    ]);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_ambiguous");
  });

  it("maps each unusable status to its own refusal", () => {
    const cases: [string, string][] = [
      ["expired", "expired"],
      ["reauthorizationRequired", "reauthorization_required"],
      ["unreachable", "unreachable"],
      ["disconnected", "unusable"],
      ["somethingNew", "unusable"],
    ];
    for (const [status, reason] of cases) {
      const verdict = resolveOperateConnection([row({ status })]);
      expect(verdict.ok, `status ${status} must refuse`).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.reason, `status ${status}`).toBe(reason);
    }
  });

  it("ignores unusable non-operate rows entirely", () => {
    const verdict = resolveOperateConnection([
      row({ access: "read-only", status: "expired" }),
      row({ access: "read-only", status: "unreachable" }),
    ]);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_not_granted");
  });

  it("still selects a usable operate row when read-only rows are also present", () => {
    const verdict = resolveOperateConnection([
      row({ connectionId: "conn_read", access: "read-only" }),
      row({ connectionId: "conn_operate" }),
    ]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.connectionId).toBe("conn_operate");
  });

  it("exposes fixed sanitized copy for every refusal reason", () => {
    const reasons = [
      "operate_not_granted",
      "operate_ambiguous",
      "expired",
      "reauthorization_required",
      "unreachable",
      "unusable",
    ] as const;
    for (const reason of reasons) {
      const detail = OPERATE_REFUSAL_DETAIL[reason];
      expect(detail.length).toBeGreaterThan(0);
      // sanitized: no token-ish or upstream-ish content
      expect(detail).not.toMatch(/bearer|token|password|secret|sk-|eyJ/i);
    }
  });
});

describe("assertOperateEnvironment", () => {
  const ok = { ok: true as const, connectionId: "conn_operate", environmentId: "env_1" };

  it("accepts the matching environment", () => {
    expect(assertOperateEnvironment(ok, "env_1")).toEqual(ok);
  });

  it("refuses a different environment instead of trusting the caller", () => {
    const verdict = assertOperateEnvironment(ok, "env_2");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("operate_ambiguous");
    expect(verdict.detail).toMatch(/different T3 environment/);
  });

  it("is case- and whitespace-sensitive (identity, not a label)", () => {
    expect(assertOperateEnvironment(ok, "ENV_1").ok).toBe(false);
    expect(assertOperateEnvironment(ok, " env_1").ok).toBe(false);
  });
});
