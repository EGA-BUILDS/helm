import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView, NativeT3Dashboard } from "./Dashboard";
import { threadDetailKey, unavailableDashboard } from "./contract";
import { fixturesEnabled } from "./fixture-gate";
import { fixtureScenarios, getFixture, type FixtureScenario } from "./fixtures";
import { filterProjects, filterThreads, threadReference, validateEndpoint } from "./ui";

function renderScenario(scenario: FixtureScenario) {
  const data = getFixture(scenario);
  if (!data) throw new Error("Test fixture not enabled");
  return renderToStaticMarkup(createElement(DashboardView, { data, preview: true }));
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_HELM_T3_FIXTURES", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("local endpoint validation", () => {
  it.each(["https://t3.example.invalid/mcp", "http://localhost:3773/mcp", "http://192.168.1.10/mcp", "http://[::1]:3773/mcp", " https://t3.example.invalid/mcp/ "])("accepts native endpoint %s without connecting", (endpoint) => {
    expect(validateEndpoint(endpoint).valid).toBe(true);
  });
  it.each(["", "t3.example.invalid/mcp", "https://t3.example.invalid", "https://t3.example.invalid/api/mcp", "ftp://t3.example.invalid/mcp", "https:t3.example.invalid/mcp", "https:///t3.example.invalid/mcp", "https://t3.example.invalid/\nmcp", "javascript:alert(1)", "https://user:password@t3.example.invalid/mcp", "https://t3.example.invalid/mcp?token=secret", "https://t3.example.invalid/mcp#fragment", "https://t3.example.invalid/mcp?", "https://t3.example.invalid/mcp#"])("rejects invalid or credential-bearing endpoint %s", (endpoint) => {
    expect(validateEndpoint(endpoint).valid).toBe(false);
  });
  it("normalizes a trailing slash without modifying the origin", () => {
    expect(validateEndpoint(" https://t3.example.invalid:443/mcp/ ")).toEqual({ valid: true, endpoint: "https://t3.example.invalid/mcp" });
  });
});

describe("connection and read states", () => {
  it("starts unavailable without claiming live connection or data", () => {
    const html = renderToStaticMarkup(createElement(DashboardView, { data: unavailableDashboard }));
    expect(html).toContain("T3 backend integration is not available yet");
    expect(html).toContain("URL validation is local");
    expect(html).not.toContain("sample-connection");
    expect(html).not.toContain("Connected · sample");
  });
  it.each([
    ["pending", "Waiting for T3 approval"], ["denied", "Sign-in was denied"],
    ["expired", "T3 sign-in expired"], ["failed", "T3 connection failed"],
  ] as const)("renders OAuth %s state", (scenario, title) => {
    const html = renderScenario(scenario);
    expect(html).toContain(title);
    expect(html).toContain("Development fixture preview — no live T3 connection");
    expect(html).not.toContain("Sample MCP endpoint");
  });
  it("does not label a backend-shaped pending state as a sample", () => {
    const data = getFixture("pending");
    if (!data) throw new Error("Test fixture not enabled");
    const html = renderToStaticMarkup(createElement(DashboardView, { data }));
    expect(html).toContain("Approval request pending.");
    expect(html).not.toContain("Sample approval request pending.");
  });
  it("labels connected data as sample and preserves unknown fields", () => {
    const html = renderScenario("connected");
    expect(html).toContain("Connected · sample");
    expect(html).toContain("Simulated connection for development preview");
    expect(html).toContain("Approval expires</dt><dd>Unknown");
    expect(html).toContain("Availability unknown");
    expect(html).toContain("Authentication</dt><dd>Unknown");
    expect(html).toContain("Example model");
    expect(html).toContain("Asynchronous polling");
    expect(html).toContain("Last activity</dt><dd>Unknown");
    expect(html).toContain("Recent runs");
  });
  it("shows multiple environment states and does not expose inactive environment data", () => {
    const html = renderScenario("connected");
    expect(html).toContain("Studio");
    expect(html).toContain("Sample · Connected");
    expect(html).toContain("Sample · Expired");
    expect(html).toContain("Sample · Disconnected");
    expect(html).toContain('aria-label="Select Laptop environment"');
    expect(html).not.toContain("Field notes</strong>");
  });
  it("distinguishes a connection with missing environments from an identity proof", () => {
    const html = renderScenario("missing-environments");
    expect(html).toContain("No environments returned");
    expect(html).toContain("does not confirm environment identity");
    expect(html).not.toContain("sample-studio</p>");
  });
  it.each([["empty-projects", "No projects returned"], ["empty-threads", "No threads returned"]] as const)("renders %s", (scenario, copy) => {
    expect(renderScenario(scenario)).toContain(copy);
  });
  it("renders populated project and thread details and timeline", () => {
    const html = renderScenario("connected");
    for (const text of ["Design system", "PROJECT DETAILS", "THREAD DETAILS", "Refine the workspace navigation", "Activity timeline", "No real agent has run.", "Copy T3 reference", "t3-thread://v1/sample-thread-navigation"]) expect(html).toContain(text);
  });
  it("scopes thread detail lookup to its connection", () => {
    const data = getFixture("connected")!;
    const detailKey = threadDetailKey("sample-connection-studio", "sample-thread-navigation");
    const otherConnectionKey = threadDetailKey("other-connection", "sample-thread-navigation");
    const detail = data.details[detailKey];
    if (!detail || detail.status !== "ready") throw new Error("Expected ready detail");
    const otherConnectionDetail = { ...detail, data: { ...detail.data, items: [{ ...detail.data.items[0], text: "Other connection activity" }] } };
    const html = renderToStaticMarkup(createElement(DashboardView, { preview: true, data: { ...data, details: { [detailKey]: detail, [otherConnectionKey]: otherConnectionDetail } } }));
    expect(html).toContain("Sample activity: inspected frontend components in a local workspace.");
    expect(html).not.toContain("Other connection activity");
  });
  it("renders provider failure without suggesting fallback availability", () => {
    const html = renderScenario("provider-unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Provider catalog is unavailable");
    expect(html).not.toContain("Example model");
  });
  it("announces loading and read errors and discloses stale data", () => {
    expect(renderScenario("loading")).toContain("Loading projects");
    expect(renderScenario("read-error")).toContain("Sample project read failed");
    expect(renderScenario("stale")).toContain("Stale — refresh required");
  });
  it("labels unavailable freshness without implying a backend snapshot", () => {
    const data = getFixture("connected")!;
    if (data.threads.status !== "ready") throw new Error("Expected ready threads");
    const html = renderToStaticMarkup(createElement(DashboardView, { preview: true, data: { ...data, threads: { status: "ready", data: { ...data.threads.data, freshness: { source: "unavailable", observedAt: null, stale: false } } } } }));
    expect(html).toContain("Source unavailable");
    expect(html).not.toContain("Backend snapshot");
  });
  it("never enables remote mutations, even in connected fixture preview", () => {
    const html = renderScenario("connected");
    for (const action of ["Reconnect", "Disconnect", "Start thread", "Send follow-up", "Interrupt thread"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${action}</button>`));
    }
    expect(html).not.toContain("Add environment");
    expect(html).not.toContain("Register project");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(renderScenario("not-connected")).toMatch(/<button[^>]*disabled=""[^>]*>Connect T3<\/button>/);
  });
  it("shows disabled pagination for cursor zero and truncated activity", () => {
    const data = getFixture("connected")!;
    if (data.projects.status !== "ready" || data.threads.status !== "ready") throw new Error("Expected ready fixture");
    const detailKey = threadDetailKey("sample-connection-studio", "sample-thread-navigation");
    const detail = data.details[detailKey];
    if (detail.status !== "ready") throw new Error("Expected ready detail");
    const html = renderToStaticMarkup(createElement(DashboardView, { preview: true, data: {
      ...data,
      projects: { status: "ready", data: { ...data.projects.data, nextCursor: 0 } },
      threads: { status: "ready", data: { ...data.threads.data, nextCursor: 0 } },
      details: { ...data.details, [detailKey]: { status: "ready", data: { ...detail.data, hasMore: true, nextPosition: 3, items: [{ ...detail.data.items[0], truncated: true, nextTextOffset: 20 }] } } },
    } }));
    for (const action of ["Load more projects", "Load more threads", "Load more activity"]) expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${action}</button>`));
    expect(html).toContain("Truncated content.");
  });
  it("exposes labeled navigation, a skip link, and named inputs", () => {
    const html = renderScenario("connected");
    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('href="#overview" aria-current="location"');
    expect(html).toContain("Skip to dashboard content");
    for (const target of ["connect", "environments", "projects", "providers", "threads"]) expect(html).toContain(`href="#${target}"`);
    expect(html).toContain('for="project-search"');
    expect(html).toContain('for="thread-project"');
    expect(html).not.toContain('role="tab"');
  });
  it("searches only supplied projects and filters threads by project", () => {
    const data = getFixture("connected")!;
    if (data.projects.status !== "ready" || data.threads.status !== "ready") throw new Error("Expected ready fixture");
    expect(filterProjects(data.projects.data.items, " DESIGN ")).toHaveLength(1);
    expect(filterProjects(data.projects.data.items, "no such project")).toHaveLength(0);
    expect(filterProjects(data.projects.data.items, "/sample/helm")[0].projectId).toBe("sample-helm");
    expect(filterThreads(data.threads.data.items, "review", "sample-helm")).toHaveLength(1);
    expect(filterThreads(data.threads.data.items, "", "sample-design")).toHaveLength(1);
    expect(filterThreads(data.threads.data.items, "", "missing")).toHaveLength(0);
  });
  it("keeps T3 reference IDs unchanged", () => expect(threadReference("thread-id")).toBe("t3-thread://v1/thread-id"));
});

describe("fixture isolation", () => {
  it.each(["production", "test"])("cannot activate fixtures in %s even with the switch", (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    expect(fixturesEnabled()).toBe(false);
    for (const scenario of fixtureScenarios) expect(getFixture(scenario)).toBeNull();
    const html = renderToStaticMarkup(createElement(NativeT3Dashboard, { accountControls: null, serviceStatus: null }));
    expect(html).not.toContain("fixture-scenario");
    expect(html).not.toContain("Development fixture preview");
    expect(html).not.toContain("sample-thread");
    expect(html).toContain("backend integration is not available");
  });
  it.each([undefined, "false", "1", "TRUE"])("requires exact explicit switch %s", (value) => {
    vi.stubEnv("NEXT_PUBLIC_HELM_T3_FIXTURES", value);
    expect(fixturesEnabled()).toBe(false);
    expect(getFixture("connected")).toBeNull();
  });
  it("generates all preview data without contacting a remote service", () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    for (const scenario of fixtureScenarios) expect(getFixture(scenario)).not.toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
});
