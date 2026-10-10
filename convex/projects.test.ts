/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const SUBJECT = "owner-placeholder";
const ISSUER = "https://helm-test.clerk.accounts.dev";
const OWNER = { subject: SUBJECT, issuer: ISSUER, tokenIdentifier: `${ISSUER}|${SUBJECT}` };
const MAPPING = {
  repository: "EGA-BUILDS/helm",
  linearProjectId: "12345678-1234-5678-1234-567812345678",
  t3EnvironmentId: "environment-placeholder",
  t3ProjectId: "project-placeholder",
  baseRef: "main",
};

async function configure(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.auth.grantOwner, { subject: SUBJECT, issuer: ISSUER });
  await t.mutation(internal.projects.upsertTrustedMapping, { ...MAPPING, ownerSubject: SUBJECT });
}

describe("trusted project mapping and connection persistence", () => {
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    previous = { HELM_OWNER_SUBJECT: process.env.HELM_OWNER_SUBJECT, CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL, LINEAR_API_KEY: process.env.LINEAR_API_KEY };
    process.env.HELM_OWNER_SUBJECT = SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = ISSUER;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects invalid mapping and prevents duplicate trusted rows", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.projects.upsertTrustedMapping, { ...MAPPING, repository: "not/a/repo/path", ownerSubject: SUBJECT })).rejects.toThrow(/invalid/);
    await t.mutation(internal.projects.upsertTrustedMapping, { ...MAPPING, ownerSubject: SUBJECT });
    await t.mutation(internal.projects.upsertTrustedMapping, { ...MAPPING, ownerSubject: SUBJECT, baseRef: "release/next" });
    const target = await t.query(internal.projects.trustedTarget, {});
    expect(target).toMatchObject({ ...MAPPING, baseRef: "release/next" });
  });

  it("enforces owner access for project data and denies anonymous or other users", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    const owner = t.withIdentity(OWNER);
    await expect(owner.query(api.projects.getOverview, {})).resolves.toMatchObject({ project: MAPPING, connections: [] });
    await expect(t.query(api.projects.getOverview, {})).rejects.toThrow(/unauthorized/);
    await expect(t.withIdentity({ subject: "other", issuer: ISSUER, tokenIdentifier: `${ISSUER}|other` }).query(api.projects.getOverview, {})).rejects.toThrow(/unauthorized/);
  });

  it("protects the owner-only check action and persists only sanitized provider results", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    await expect(t.action(api.connections.check, { kind: "linear" })).rejects.toThrow(/unauthorized/);
    process.env.LINEAR_API_KEY = "synthetic-linear-key";
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "viewer" }, project: { id: MAPPING.linearProjectId } } }), { status: 200 })) as typeof fetch;
    try {
      const owner = t.withIdentity(OWNER);
      const result = await owner.action(api.connections.check, { kind: "linear" });
      expect(result).toMatchObject({ status: "connected", capabilities: ["linear.project.read"], errorCategory: null });
      expect(JSON.stringify(result)).not.toContain("synthetic-linear-key");
      await expect(owner.query(api.projects.getOverview, {})).resolves.toMatchObject({ connections: [{ kind: "linear", status: "connected" }] });
    } finally {
      globalThis.fetch = priorFetch;
      if (previous.LINEAR_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previous.LINEAR_API_KEY;
    }
  });

  it("rejects a mismatched issuer or token identifier before provider access", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    const priorFetch = globalThis.fetch;
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;
    try {
      await expect(t.withIdentity({ subject: SUBJECT, issuer: "https://other.clerk.accounts.dev", tokenIdentifier: `${ISSUER}|${SUBJECT}` }).action(api.connections.check, { kind: "linear" })).rejects.toThrow(/unauthorized/);
      await expect(t.withIdentity({ subject: SUBJECT, issuer: ISSUER, tokenIdentifier: "wrong-token-id" }).action(api.connections.check, { kind: "linear" })).rejects.toThrow(/unauthorized/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rechecks the owner grant after the remote check and refuses persistence after revocation", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    process.env.LINEAR_API_KEY = "synthetic-linear-key";
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      await t.mutation(internal.auth.revokeOwner, { subject: SUBJECT });
      return new Response(JSON.stringify({ data: { viewer: { id: "viewer" }, project: { id: MAPPING.linearProjectId } } }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(t.withIdentity(OWNER).action(api.connections.check, { kind: "linear" })).rejects.toThrow(/unauthorized/);
      const overview = await t.run(async (ctx) => await ctx.db.query("serviceConnections").collect());
      expect(overview).toMatchObject([{ status: "blocked", errorCategory: "check_in_progress", lastSuccessAt: null }]);
    } finally {
      globalThis.fetch = priorFetch;
      if (previous.LINEAR_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previous.LINEAR_API_KEY;
    }
  });

  it("prevents an older concurrent check from overwriting a newer result", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    const ownerGrant = { subject: SUBJECT, issuer: ISSUER, revision: 1 };
    const first = await t.mutation(internal.connections.reserveCheck, { kind: "linear", ownerGrant });
    const second = await t.mutation(internal.connections.reserveCheck, { kind: "linear", ownerGrant });
    expect(first?.generation).toBe(1);
    expect(second?.generation).toBe(2);
    const stale = await t.mutation(internal.connections.finishCheck, { kind: "linear", generation: 1, ownerGrant, result: { ok: true, category: null, capabilities: ["old"], catalogObservedAt: null } });
    expect(stale).toBeNull();
    const newest = await t.mutation(internal.connections.finishCheck, { kind: "linear", generation: 2, ownerGrant, result: { ok: true, category: null, capabilities: ["new"], catalogObservedAt: null } });
    expect(newest).toMatchObject({ status: "connected", capabilities: ["new"] });
  });

  it("invalidates prior health and in-flight check results when the trusted mapping changes", async () => {
    const t = convexTest(schema, modules);
    await configure(t);
    const target = await t.query(internal.projects.trustedTarget, {});
    if (!target) throw new Error("test project mapping missing");
    await t.run((ctx) => ctx.db.insert("serviceConnections", {
      projectId: target.id,
      kind: "t3",
      configuredIdentity: `${MAPPING.t3EnvironmentId}/${MAPPING.t3ProjectId}`,
      status: "connected",
      generation: 1,
      lastCheckAt: Date.now(),
      lastSuccessAt: Date.now(),
      errorCategory: null,
      guidance: null,
      capabilities: ["t3.project.read"],
      catalogObservedAt: null,
    }));
    const inFlight = await t.mutation(internal.connections.reserveCheck, {
      kind: "linear",
      ownerGrant: { subject: SUBJECT, issuer: ISSUER, revision: 1 },
    });
    expect(inFlight?.generation).toBe(1);

    await t.mutation(internal.projects.upsertTrustedMapping, {
      ...MAPPING,
      t3ProjectId: "next-project-placeholder",
      ownerSubject: SUBJECT,
    });
    const targetAfterChange = await t.query(internal.projects.trustedTarget, {});
    expect(targetAfterChange?.t3Status).toBe("blocked");
    const stale = await t.mutation(internal.connections.finishCheck, {
      kind: "linear",
      generation: inFlight!.generation,
      ownerGrant: { subject: SUBJECT, issuer: ISSUER, revision: 1 },
      result: { ok: true, category: null, capabilities: ["linear.project.read"], catalogObservedAt: null },
    });
    expect(stale).toBeNull();
    const overview = await t.withIdentity(OWNER).query(api.projects.getOverview, {});
    expect(overview.connections.find((row) => row.kind === "t3")).toMatchObject({
      status: "blocked",
      lastSuccessAt: null,
      errorCategory: "configuration_changed",
      capabilities: [],
      catalogObservedAt: null,
    });
  });
});
