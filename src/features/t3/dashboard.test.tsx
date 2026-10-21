import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView, NativeT3Dashboard } from "./Dashboard";
import { threadDetailKey, unavailableDashboard, type DashboardData } from "./contract";
import type { T3DashboardController } from "./useT3Dashboard";
import { fixturesEnabled } from "./fixture-gate";
import { fixtureScenarios, getFixture, type FixtureScenario } from "./fixtures";
import { filterProjects, filterThreads, connectActionLabel, connectActionPending, threadReference, validateEndpoint } from "./ui";

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
  it.each([
    "https://t3coderelay.com/mcp",
    "https://studio.t3coderelay.com/mcp",
    "https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp",
    "HTTPS://studio.t3coderelay.com/mcp",
    " https://studio.t3coderelay.com/mcp/ ",
    " https://studio.t3coderelay.com:443/mcp/ ",
  ])("accepts a trusted native T3 Connect endpoint %s", (endpoint) => {
    expect(validateEndpoint(endpoint).valid).toBe(true);
  });
  it("normalizes a trailing slash and the default port without modifying the origin", () => {
    expect(validateEndpoint(" https://studio.t3coderelay.com:443/mcp/ ")).toEqual({ valid: true, endpoint: "https://studio.t3coderelay.com/mcp" });
  });
  // The backend only ever accepts https, so promising an HTTP URL is valid here
  // would be exactly the misleading feedback this check exists to prevent.
  it.each([
    "http://studio.t3coderelay.com/mcp",
    "http://localhost:3773/mcp",
    "http://192.168.1.10/mcp",
    "http://[::1]:3773/mcp",
    "ftp://studio.t3coderelay.com/mcp",
    "javascript:alert(1)",
  ])("rejects non-HTTPS endpoint %s with an HTTPS-specific reason", (endpoint) => {
    expect(validateEndpoint(endpoint)).toEqual({ valid: false, message: "T3 Connect URLs must use HTTPS." });
  });
  // A suffix match is not a subdomain match: "evil-t3coderelay.com" must fail.
  it.each([
    "https://t3.example.invalid/mcp",
    "https://evil-t3coderelay.com/mcp",
    "https://not-t3coderelay.com/mcp",
    "https://t3coderelay.com.evil.com/mcp",
  ])("rejects untrusted host %s", (endpoint) => {
    expect(validateEndpoint(endpoint)).toEqual({ valid: false, message: "Helm only connects to T3 Connect endpoints under t3coderelay.com." });
  });
  it.each([
    ["", "Enter the MCP URL copied from T3 Settings → Connections."],
    ["t3coderelay.com/mcp", "Enter a complete URL ending in /mcp, for example https://your-environment.t3coderelay.com/mcp."],
    ["https:t3coderelay.com/mcp", "Enter a complete URL ending in /mcp, for example https://your-environment.t3coderelay.com/mcp."],
    ["https:///t3coderelay.com/mcp", "Enter a complete URL ending in /mcp, for example https://your-environment.t3coderelay.com/mcp."],
    ["https://studio.t3coderelay.com/mcp/\nmcp", "Enter a complete URL ending in /mcp, for example https://your-environment.t3coderelay.com/mcp."],
    ["https://studio.t3coderelay.com", "The native T3 MCP URL must end in /mcp."],
    ["https://studio.t3coderelay.com/api/mcp", "The native T3 MCP URL must end in /mcp."],
    ["https://studio.t3coderelay.com:8443/mcp", "Remove the port number. T3 Connect endpoints use the default HTTPS port."],
    ["https://user:password@studio.t3coderelay.com/mcp", "Remove the username or password from the URL. T3 Connect URLs never embed credentials."],
    ["https://studio.t3coderelay.com/mcp?token=secret", "Remove the query string or fragment. The MCP URL is only the path ending in /mcp."],
    ["https://studio.t3coderelay.com/mcp#fragment", "Remove the query string or fragment. The MCP URL is only the path ending in /mcp."],
    ["https://studio.t3coderelay.com/mcp?", "Remove the query string or fragment. The MCP URL is only the path ending in /mcp."],
    ["https://studio.t3coderelay.com/mcp#", "Remove the query string or fragment. The MCP URL is only the path ending in /mcp."],
  ])("explains specifically why %s is rejected", (endpoint, message) => {
    expect(validateEndpoint(endpoint)).toEqual({ valid: false, message });
  });
});

describe("connect action labelling", () => {
  it("offers Connect T3 when nothing is saved", () => {
    expect(connectActionLabel({ status: "not-connected" })).toBe("Connect T3");
  });
  // The form is only rendered when no grant is saved, so a denied or failed
  // attempt must offer a new connection — never a "Reconnect" that implies a
  // saved connection the owner does not have.
  it.each([
    { status: "denied" } as const,
    { status: "failed", error: { code: "unknown", message: "x", retryable: false } } as const,
    { status: "expired", expiredAt: null } as const,
  ])("offers Connect T3 rather than Reconnect after %o", (state) => {
    expect(connectActionLabel(state)).toBe("Connect T3");
    expect(connectActionPending(state)).toBe(false);
  });
  it("shows an explicit waiting state while consent is outstanding", () => {
    const pending = { status: "pending", expiresAt: null } as const;
    expect(connectActionLabel(pending)).toBe("Waiting for T3 approval…");
    expect(connectActionPending(pending)).toBe(true);
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
    const detailKey = threadDetailKey("sample-connection-studio", "sample-helm", "sample-thread-navigation");
    const otherConnectionKey = threadDetailKey("other-connection", "sample-helm", "sample-thread-navigation");
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
  it("never mounts a native write control in a fixture preview", () => {
    // EGA-764/765 made launch, follow-up and interrupt REAL operations. What must
    // still hold is that a fixture preview never reaches the network: the write
    // controls are not mounted at all, rather than rendered disabled.
    const html = renderScenario("connected");
    expect(html).not.toContain("Follow-up message");
    expect(html).not.toContain("Send follow-up");
    expect(html).not.toContain("Interrupt thread");
    expect(html).toMatch(/Sample data: native controls are not available/);
    // Unimplemented operations remain unavailable, and remain visibly disabled.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start thread<\/button>/);
    for (const action of ["Reconnect", "Disconnect"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${action}</button>`));
    }
    expect(html).not.toContain("Add environment");
    expect(html).not.toContain("Register project");
    expect(renderScenario("not-connected")).toMatch(/<button[^>]*disabled=""[^>]*>Connect T3<\/button>/);
  });
  it("shows disabled pagination for cursor zero and truncated activity", () => {
    const data = getFixture("connected")!;
    if (data.projects.status !== "ready" || data.threads.status !== "ready") throw new Error("Expected ready fixture");
    const detailKey = threadDetailKey("sample-connection-studio", "sample-helm", "sample-thread-navigation");
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

describe("operate gating (live)", () => {
  function makeController(data: DashboardData) {
    return {
      data,
      actions: {
        selectConnection: () => {},
        selectProject: () => {},
        selectThread: () => {},
        setThreadView: () => {},
        setThreadQuery: () => {},
        setThreadStatuses: () => {},
        clearThreadFilters: () => {},
        connect: async () => {},
        reconnect: async () => {},
        refresh: async () => {},
        disconnect: async () => {},
        loadMoreProjects: () => {},
        loadMoreThreads: () => {},
        loadMoreActivity: () => {},
        loadTruncatedText: () => {},
        applyCallbackStatus: () => {},
        reloadActivity: () => {},
      },
      selection: { connectionId: "sample-connection-studio", projectId: "sample-helm", threadId: "sample-thread-navigation", threadProjectId: "sample-helm" },
      threadQueryInput: "",
      threadView: "selected-project",
      threadProjectId: "sample-helm",
      threadPages: {},
      threadStatuses: [],
      observedThreadStatuses: [],
      busy: null,
      paging: { projects: false, threads: false, activity: false },
      notice: null,
      error: null,
      live: true,
    } as unknown as T3DashboardController;
  }
  it("mounts write controls for an operate connection with a selected thread", () => {
    const data = getFixture("connected")!;
    if (data.environments.status !== "ready" || data.threads.status !== "ready") throw new Error("Expected ready fixture");
    const detailKey = threadDetailKey("sample-connection-studio", "sample-helm", "sample-thread-navigation");
    const existingDetail = data.details[detailKey];
    if (!existingDetail || existingDetail.status !== "ready") throw new Error("Expected ready detail");
    const operateData = {
      ...data,
      environments: {
        ...data.environments,
        data: {
          ...data.environments.data,
          items: data.environments.data.items.map((item) =>
            item.connection.connectionId === "sample-connection-studio"
              ? { ...item, connection: { ...item.connection, access: "operate" as const } }
              : item,
          ),
        },
      },
      connection: { status: "connected" as const, connection: { ...data.environments.data.items[0].connection, access: "operate" as const } },
      details: {
        ...data.details,
        [detailKey]: {
          status: "ready" as const,
          data: {
            ...existingDetail.data,
            recentRuns: [{ runId: "sample-run-live", ordinal: 1, status: "running", providerInstanceId: "sample-provider", model: "sample-model", requestedAt: null, startedAt: null, completedAt: null }],
          },
        },
      },
    };
    const html = renderToStaticMarkup(createElement(DashboardView, { data: operateData, controller: makeController(operateData) }));
    expect(html).toContain("Follow-up message");
    expect(html).toContain("Send follow-up");
    expect(html).toMatch(/Interrupt/);
  });
  it("mounts no write controls for a read-only connection with a selected thread", () => {
    const data = getFixture("connected")!;
    const html = renderToStaticMarkup(createElement(DashboardView, { data, controller: makeController(data) }));
    expect(html).not.toContain("Follow-up message");
    expect(html).not.toContain("Send follow-up");
    expect(html).toContain("This connection is read-only");
  });
  it("offers an add-another-access-level control instead of hiding the form behind the saved connection", () => {
    const data = getFixture("connected")!;
    const html = renderToStaticMarkup(createElement(DashboardView, { data, controller: makeController(data) }));
    // A saved Read-only connection must not hide the way to add Operate: the
    // backend allows one active connection per tier, so a second consent is
    // added rather than the existing grant being disconnected.
    expect(html).toContain("Add another access level");
    // The saved connection and its own level remain visible and unchanged.
    expect(html).toContain("Reconnecting keeps this level");
    expect(html).toContain("Approved access");
    // And the saved-connection card is what is on screen: the new-connection
    // form (and its endpoint input) is not rendered until the owner asks for it.
    expect(html).not.toContain('id="t3-endpoint"');
  });
  it("does not offer an add-another-access-level control in a fixture preview", () => {
    // A preview is not a live controller, so it must not offer a consent.
    const html = renderScenario("connected");
    expect(html).not.toContain("Add another access level");
  });
});

describe("access choice default", () => {
  it("defaults to read-only", () => {
    const html = renderScenario("not-connected");
    expect(html).toContain('value="read-only"');
    // The read-only radio is the default selection.
    expect(html).toMatch(/checked="" value="read-only"/);
  });
});

describe("fixture isolation", () => {
  it.each(["production", "test"])("cannot activate fixtures in %s even with the switch", (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const network = vi.spyOn(globalThis, "fetch");
    expect(fixturesEnabled()).toBe(false);
    for (const scenario of fixtureScenarios) expect(getFixture(scenario)).toBeNull();
    const html = renderToStaticMarkup(createElement(NativeT3Dashboard, { accountControls: null, serviceStatus: null }));
    expect(html).not.toContain("fixture-scenario");
    expect(html).not.toContain("Development fixture preview");
    expect(html).not.toContain("sample-thread");
    expect(html).toContain("No verified T3 connection yet");
    // Server rendering must never reach for T3, and no fixture can stand in.
    expect(network).not.toHaveBeenCalled();
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
