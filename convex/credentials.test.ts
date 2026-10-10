import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

// Per convex/_generated/ai/guidelines.md: build the module registry with
// import.meta.glob and drive functions through generated api references.
const modules = import.meta.glob("./**/*.ts");

/**
 * EGA-677 task 4: dispatch must PAUSE on auth failure, and must be able to resume
 * only after the owner reauthorizes.
 */
describe("credentials", () => {
  const at = 1_700_000_000_000;

  it("blocks dispatch when no credential has ever been recorded", async () => {
    const t = convexTest(schema, modules);
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(false);
    expect(gate.status).toBe("unknown");
  });

  it("allows dispatch after a credential is recorded", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read", "orchestration:operate"],
      issuedAt: at,
      expiresAt: at + 2_592_000_000,
    });
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(true);
    expect(gate.status).toBe("active");
    expect(gate.expiresAt).toBe(at + 2_592_000_000);
  });

  it("pauses dispatch on the first auth failure, whatever the class", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read"],
      issuedAt: at,
      expiresAt: null,
    });
    // The live endpoint returns one tag for expired, revoked and malformed alike.
    await t.mutation(internal.credentials.recordAuthFailure, {
      provider: "t3-mcp",
      at: at + 1,
      failureClass: "invalid_mcp_credential",
    });
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(false);
    expect(gate.status).toBe("reauthorizationRequired");
    expect(gate.reason).toContain("reauthorization required");
  });

  it("treats a failure with no prior credential as reauthorization-required", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordAuthFailure, {
      provider: "t3-mcp",
      at,
      failureClass: "invalid_mcp_credential",
    });
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(false);
    expect(gate.status).toBe("reauthorizationRequired");
  });

  it("does not auto-retry: repeated failures stay paused and only count up", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read"],
      issuedAt: at,
      expiresAt: null,
    });
    for (let i = 1; i <= 3; i++) {
      await t.mutation(internal.credentials.recordAuthFailure, {
        provider: "t3-mcp",
        at: at + i,
        failureClass: "invalid_mcp_credential",
      });
    }
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(false);
    const rows = await t.query(internal.credentials.listCredentials, {});
    expect(rows[0]?.consecutiveFailures).toBe(3);
    expect(rows[0]?.status).toBe("reauthorizationRequired");
  });

  it("resumes only after the owner reauthorizes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read"],
      issuedAt: at,
      expiresAt: null,
    });
    await t.mutation(internal.credentials.recordAuthFailure, {
      provider: "t3-mcp",
      at: at + 1,
      failureClass: "invalid_mcp_credential",
    });
    expect((await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" })).allowed).toBe(false);

    // Owner reauthorizes: a new issuance clears the failure state.
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read", "orchestration:operate"],
      issuedAt: at + 100,
      expiresAt: at + 200,
    });
    const gate = await t.query(internal.credentials.canDispatch, { provider: "t3-mcp" });
    expect(gate.allowed).toBe(true);
    const rows = await t.query(internal.credentials.listCredentials, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consecutiveFailures).toBe(0);
    expect(rows[0]?.lastFailureClass).toBe(null);
  });

  it("never stores a credential value", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.credentials.recordCredential, {
      provider: "t3-mcp",
      scopes: ["orchestration:read"],
      issuedAt: at,
      expiresAt: null,
    });
    const rows = await t.query(internal.credentials.listCredentials, {});
    // Metadata only: no field that could hold a token.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "consecutiveFailures",
      "expiresAt",
      "issuedAt",
      "lastFailureAt",
      "lastFailureClass",
      "lastVerifiedAt",
      "provider",
      "scopes",
      "status",
    ]);
  });
});