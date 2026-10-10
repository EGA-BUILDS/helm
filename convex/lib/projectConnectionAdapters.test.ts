import { describe, expect, it, vi } from "vitest";
import { verifyLinearProject, verifyT3Project } from "./projectConnectionAdapters";

describe("Linear project adapter", () => {
  it("proves viewer auth and exact project identity using a mocked transport", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" }, project: { id: "project-1" } } }), { status: 200 }));
    await expect(verifyLinearProject({ projectId: "project-1", apiKey: "synthetic-key", fetcher })).resolves.toMatchObject({ ok: true, capabilities: ["linear.project.read"] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("categorizes auth, mismatch, transport and malformed responses without returning bodies", async () => {
    const response = (status: number, body = "{}"): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;
    expect(await verifyLinearProject({ projectId: "p", apiKey: "k", fetcher: response(401) })).toMatchObject({ ok: false, category: "unauthorized" });
    expect(await verifyLinearProject({ projectId: "p", apiKey: "k", fetcher: response(200, JSON.stringify({ data: { viewer: { id: "v" }, project: { id: "other" } } })) })).toMatchObject({ ok: false, category: "wrong_identity" });
    expect(await verifyLinearProject({ projectId: "p", apiKey: "k", fetcher: response(200, "not-json") })).toMatchObject({ ok: false, category: "unsupported_response" });
    expect(await verifyLinearProject({ projectId: "p", apiKey: "k", fetcher: response(200, JSON.stringify({ data: { viewer: { id: "v" }, project: { id: "p" } }, errors: [{ message: "partial" }] })) })).toMatchObject({ ok: false, category: "unsupported_response" });
    expect(await verifyLinearProject({ projectId: "p", apiKey: "k", fetcher: (async () => { throw new Error("synthetic network failure"); }) as typeof fetch })).toMatchObject({ ok: false, category: "transport" });
  });
});

describe("T3 identity adapter", () => {
  const callTool = (projectRows: unknown, capabilities: unknown = { capabilities: ["threads.read"] }, environment: unknown = { environmentId: "env-1" }) => vi.fn(async (name: string) => ({ content: [{ type: "text", text: JSON.stringify(name === "t3_project_list" ? projectRows : name === "t3_environment_read" ? environment : capabilities) }] }));

  it("requires an explicit matching environment and project", async () => {
    const caller = callTool({ projects: [{ id: "project-1", environmentId: "env-1" }] });
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: caller, observedAt: 1234 })).resolves.toMatchObject({ ok: true, capabilities: ["t3.project.read", "threads.read"], catalogObservedAt: 1234 });
    expect(caller).toHaveBeenCalledTimes(3);
  });

  it("does not claim a fresh capability catalog for an unsupported capability response", async () => {
    await expect(verifyT3Project({
      environmentId: "env-1",
      projectId: "project-1",
      callTool: callTool({ projects: [{ id: "project-1" }] }, { providers: [] }),
      observedAt: 1234,
    })).resolves.toMatchObject({ ok: false, category: "unsupported_response", catalogObservedAt: null });
  });

  it("fails closed for missing, conflicting or unsupported identities", async () => {
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: callTool({ projects: [{ id: "project-1", environmentId: "env-2" }] }) })).resolves.toMatchObject({ ok: false, category: "wrong_identity" });
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: callTool({ projects: [{ id: "other-project", projectId: "project-1" }] }) })).resolves.toMatchObject({ ok: false, category: "wrong_identity" });
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: callTool({ arbitrary: true }) })).resolves.toMatchObject({ ok: false, category: "unsupported_response" });
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: callTool({ projects: [{ id: "project-1" }] }, { capabilities: [] }, { environmentId: "env-2" }) })).resolves.toMatchObject({ ok: false, category: "wrong_identity" });
    await expect(verifyT3Project({ environmentId: "env-1", projectId: "project-1", callTool: vi.fn(async () => { throw new Error("synthetic timeout"); }) })).resolves.toMatchObject({ ok: false, category: "timeout" });
  });
});
