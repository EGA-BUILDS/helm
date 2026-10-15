import { describe, expect, it, vi } from "vitest";
import {
  createT3Adapter,
  decodeConnection,
  isApprovedAuthorizationUrl,
  toUiError,
  T3RequestError,
} from "./backend";
import type { ConnectionRecord } from "./contract";

/** Builds a fetch double that records requests and replays queued responses. */
function stubFetch(responses: readonly unknown[], status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status: status[index - 1] ?? status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const connectedWire = {
  connectionId: "conn_1",
  displayName: "Studio",
  endpoint: "https://studio.t3coderelay.com/mcp",
  environmentId: "env_1",
  access: "read-only",
  status: "connected",
  lastVerifiedAt: "2026-10-12T09:00:00.000Z",
  lastReadAt: "2026-10-12T09:05:00.000Z",
  errorCode: null,
  expiresAt: "2026-11-11T09:00:00.000Z",
};

function wireConnection(overrides: Record<string, unknown> = {}) {
  return { connections: [{ ...connectedWire, ...overrides }] };
}

const freshness = { source: "backend" as const, observedAt: "2026-10-12T09:05:00.000Z", stale: false };

describe("connection decoding", () => {
  it("projects the backend's displayName, nullable fields and read metadata", async () => {
    const { fetchImpl } = stubFetch([wireConnection()]);
    const connections = await createT3Adapter(fetchImpl).listConnections();
    expect(connections).toEqual<ConnectionRecord[]>([{
      connectionId: "conn_1",
      displayName: "Studio",
      endpoint: "https://studio.t3coderelay.com/mcp",
      environmentId: "env_1",
      access: "read-only",
      status: "connected",
      lastVerifiedAt: "2026-10-12T09:00:00.000Z",
      lastReadAt: "2026-10-12T09:05:00.000Z",
      errorCode: null,
      expiresAt: "2026-11-11T09:00:00.000Z",
    }]);
  });

  it.each(["connected", "expired", "revoked", "unreachable"])("accepts the known status %s", (status) => {
    expect(decodeConnection({ ...connectedWire, status }).status).toBe(status);
  });

  it("rejects an unrecognized status instead of guessing a connected state", () => {
    expect(() => decodeConnection({ ...connectedWire, status: "superconnected" })).toThrow(T3RequestError);
    expect(toUiError(syncError(() => decodeConnection({ ...connectedWire, status: "superconnected" }))).code).toBe("malformed_response");
  });

  it.each(["authorization_required", "authorization_expired", "endpoint_identity_changed", "rate_limited", "read_failed", "unreachable"])("keeps the known error code %s", (errorCode) => {
    expect(decodeConnection({ ...connectedWire, errorCode }).errorCode).toBe(errorCode);
  });

  it("treats an unknown error code as unknown rather than inventing one", () => {
    expect(decodeConnection({ ...connectedWire, errorCode: "brand_new" }).errorCode).toBeNull();
  });

  it("preserves null read timestamps instead of inventing a verification", () => {
    const connection = decodeConnection({ ...connectedWire, lastReadAt: null, lastVerifiedAt: null, displayName: null, environmentId: null });
    expect(connection.lastReadAt).toBeNull();
    expect(connection.lastVerifiedAt).toBeNull();
    expect(connection.displayName).toBeNull();
    expect(connection.environmentId).toBeNull();
  });

  it("treats an unknown access level as unknown", () => {
    expect(decodeConnection({ ...connectedWire, access: "root" }).access).toBeNull();
  });
});

describe("transport errors", () => {
  it("maps a 401 to access_denied and never echoes a raw body", async () => {
    const { fetchImpl } = stubFetch([{ error: { code: "access_denied", message: "Sign in with the Helm owner account to continue.", retryable: false } }], 401);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error).toMatchObject({ code: "access_denied", retryable: false });
    expect(error.message).toBe("Sign in with the Helm owner account to continue.");
  });

  it.each([
    ["revoked", "revoked", false],
    ["connection_expired", "connection_expired", false],
    ["cursor_invalid", "cursor_invalid", false],
    ["rate_limited", "rate_limited", true],
    ["unreachable", "unreachable", true],
    ["not_found", "not_found", false],
  ])("maps backend code %s onto the UI vocabulary", async (wire, code, retryable) => {
    const { fetchImpl } = stubFetch([{ error: { code: wire, message: "sanitized", retryable } }], 502);
    expect(toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()))).toMatchObject({ code, retryable });
  });

  it("falls back to a safe message when the backend omits one", async () => {
    const { fetchImpl } = stubFetch([{ error: { code: "revoked" } }], 502);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error.message).toBe("T3 authorization was revoked. Reconnect to continue.");
  });

  it("strips control characters from a backend message", async () => {
    const { fetchImpl } = stubFetch([{ error: { code: "unknown", message: `line one\n\u0000\u001b[31mline two`, retryable: false } }], 502);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error.message).not.toContain("\n");
    expect(error.message).toContain("line one");
  });

  it("never surfaces a raw non-JSON error body", async () => {
    const fetchImpl = async () => new Response("<html>502 Bad Gateway nginx</html>", { status: 502, headers: { "content-type": "text/html" } });
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error.message).not.toContain("nginx");
    expect(error.code).toBe("unknown");
  });

  it("reports an unreachable service as retryable rather than empty data", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error).toMatchObject({ code: "backend_unavailable", retryable: true });
  });

  it("rethrows an abort instead of reporting a transport failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(createT3Adapter(fetchImpl).listConnections(controller.signal)).rejects.toThrow();
  });

  it("sends same-origin credentials and no-store caching", async () => {
    const { fetchImpl, calls } = stubFetch([wireConnection()]);
    await createT3Adapter(fetchImpl).listConnections();
    expect(calls[0].url).toBe("/api/t3/connections");
    expect(calls[0].init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
});

describe("malformed 2xx payloads", () => {
  it.each([
    ["an array", []],
    ["a bare string", "connected"],
    ["a missing connections array", { data: {} }],
    ["a connection with no id", { connections: [{ ...connectedWire, connectionId: "" }] }],
    ["a connection with a numeric endpoint", { connections: [{ ...connectedWire, endpoint: 7 }] }],
    ["a connection with an object access", { connections: [{ ...connectedWire, access: {} }] }],
  ])("rejects %s rather than returning an empty successful list", async (_label, body) => {
    const { fetchImpl } = stubFetch([body]);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listConnections()));
    expect(error.code).toBe("malformed_response");
  });

  it("never converts a malformed read into an empty page", async () => {
    const { fetchImpl } = stubFetch([{ data: { items: "not-an-array", nextCursor: null, total: 0 }, observedAt: "x", freshness }]);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).listProjects({ connectionId: "conn_1" })));
    expect(error.code).toBe("malformed_response");
  });
});

describe("read projections", () => {
  it("maps the environment identity with honest nulls", async () => {
    const { fetchImpl } = stubFetch([{ data: { environmentId: "env_1", label: null, serverVersion: null, platform: "linux/x64", metadata: null }, observedAt: "2026-10-12T09:05:00.000Z", freshness }]);
    const environment = await createT3Adapter(fetchImpl).readEnvironment({ connectionId: "conn_1" });
    expect(environment).toEqual({ environmentId: "env_1", label: null, serverVersion: null, platform: "linux/x64", metadata: null });
  });

  it("maps the catalog without claiming authentication or availability", async () => {
    const { fetchImpl } = stubFetch([{ data: {
      providers: [{ providerInstanceId: "p1", driverKind: null, displayName: null, models: [{ id: "m1", label: null, options: null }], runtimeModes: null, canRunChildTask: null, canRunCrossProviderChildTask: null, authenticationStatus: null, availability: null, constraints: null }],
      features: { appOwnedSubagents: null, asyncPolling: true, cancellation: null, batchThreadCreation: null, threadManagement: null, incrementalThreadRead: null, scheduledTasks: null, maxBatchThreads: null },
      runtimeMode: null, interactionMode: "default", parentThreadId: null, inheritedProviderInstanceId: null, inheritedModel: null,
    }, observedAt: "2026-10-12T09:05:00.000Z", freshness }]);
    const catalog = await createT3Adapter(fetchImpl).readCatalog({ connectionId: "conn_1" });
    expect(catalog.providers[0]).toMatchObject({ providerInstanceId: "p1", authenticationStatus: null, availability: null, models: [{ id: "m1", label: null }] });
    expect(catalog.features).toMatchObject({ asyncPolling: true, appOwnedSubagents: null, maxBatchThreads: null });
    expect(catalog.runtimeMode).toBeNull();
    expect(catalog.freshness).toEqual(freshness);
  });

  it("keeps a provider's models unknown when upstream reports null", async () => {
    const { fetchImpl } = stubFetch([{ data: { providers: [{ providerInstanceId: "p1", models: null, runtimeModes: null, canRunChildTask: null, canRunCrossProviderChildTask: null, constraints: null }], features: null }, observedAt: "t", freshness }]);
    const catalog = await createT3Adapter(fetchImpl).readCatalog({ connectionId: "conn_1" });
    expect(catalog.providers[0].models).toBeNull();
    expect(catalog.features).toBeNull();
  });

  it("keeps cursor zero as a real cursor and a null total as unknown", async () => {
    const { fetchImpl } = stubFetch([{ data: { items: [], nextCursor: 0, total: null }, observedAt: "t", freshness }]);
    const page = await createT3Adapter(fetchImpl).listProjects({ connectionId: "conn_1" });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe(0);
    expect(page.total).toBeNull();
  });

  it("scopes the thread read to a project and forwards native filters", async () => {
    const { fetchImpl, calls } = stubFetch([{ data: { items: [], nextCursor: null, total: 0 }, observedAt: "t", freshness }]);
    await createT3Adapter(fetchImpl).listThreads({ connectionId: "conn_1", projectId: "proj_1", cursor: 0, limit: 25, titleContains: "nav", statuses: ["running", "waiting"] });
    expect(calls[0].url).toBe("/api/t3/connections/conn_1/threads?projectId=proj_1&cursor=0&limit=25&titleContains=nav&statuses=running&statuses=waiting");
  });

  it("omits absent optional filters rather than sending empty values", async () => {
    const { fetchImpl, calls } = stubFetch([{ data: { items: [], nextCursor: null, total: 0 }, observedAt: "t", freshness }]);
    await createT3Adapter(fetchImpl).listThreads({ connectionId: "conn_1", projectId: "proj_1" });
    expect(calls[0].url).toBe("/api/t3/connections/conn_1/threads?projectId=proj_1");
  });

  it("maps thread detail including truncation metadata", async () => {
    const { fetchImpl } = stubFetch([{ data: {
      thread: { connectionId: "conn_1", threadId: "thr_1", projectId: "proj_1", environmentId: "env_1", title: null, status: null, updatedAt: null },
      items: [{ id: "item_1", position: 0, kind: "assistant", text: "part", createdAt: null, truncated: true, nextTextOffset: 20 }],
      recentRuns: [], nextPosition: 0, hasMore: true,
    }, observedAt: "t", freshness }]);
    const detail = await createT3Adapter(fetchImpl).readThread({ connectionId: "conn_1", threadId: "thr_1" });
    expect(detail.items[0]).toMatchObject({ id: "item_1", truncated: true, nextTextOffset: 20 });
    expect(detail.nextPosition).toBe(0);
    expect(detail.hasMore).toBe(true);
  });

  it("fails when truncated-text continuation returns no matching item", async () => {
    const { fetchImpl } = stubFetch([{ data: { thread: { connectionId: "conn_1", threadId: "thr_1", projectId: "p", environmentId: "e" }, items: [], recentRuns: [], nextPosition: null, hasMore: false }, observedAt: "t", freshness }]);
    const error = toUiError(await catchError(() => createT3Adapter(fetchImpl).loadTruncatedText({ connectionId: "conn_1", threadId: "thr_1", itemId: "item_1", textOffset: 20 })));
    expect(error.code).toBe("not_found");
  });

  it("requests truncated text with the item id and offset", async () => {
    const { fetchImpl, calls } = stubFetch([{ data: { thread: { connectionId: "conn_1", threadId: "thr_1", projectId: "p", environmentId: "e" }, items: [{ id: "item_1", position: 0, kind: null, text: "more", createdAt: null, truncated: true, nextTextOffset: 40 }], recentRuns: [], nextPosition: null, hasMore: false }, observedAt: "t", freshness }]);
    const item = await createT3Adapter(fetchImpl).loadTruncatedText({ connectionId: "conn_1", threadId: "thr_1", itemId: "item_1", textOffset: 20 });
    expect(calls[0].url).toContain("itemId=item_1");
    expect(calls[0].url).toContain("textOffset=20");
    expect(item.text).toBe("more");
  });

  it("reads a project detail by id", async () => {
    const { fetchImpl, calls } = stubFetch([{ data: { connectionId: "conn_1", projectId: "proj_1", environmentId: "env_1", title: "Helm" }, observedAt: "t", freshness }]);
    const project = await createT3Adapter(fetchImpl).readProject({ connectionId: "conn_1", projectId: "proj_1" });
    expect(calls[0].url).toBe("/api/t3/connections/conn_1/project?projectId=proj_1");
    expect(project.repositoryIdentity).toBeNull();
  });

  /**
   * A detail read is only meaningful if it describes the project that was
   * requested. Rendering another project's fields would mislabel the panel, so
   * a mismatched identity is rejected at the transport boundary.
   */
  it("rejects a detail response carrying a different project id", async () => {
    const { fetchImpl } = stubFetch([{ data: { connectionId: "conn_1", projectId: "proj_other", environmentId: "env_1", title: "Wrong" }, observedAt: "t", freshness }]);
    await expect(createT3Adapter(fetchImpl).readProject({ connectionId: "conn_1", projectId: "proj_1" })).rejects.toMatchObject({ uiError: { code: "malformed_response" } });
  });

  it("rejects a detail response carrying a different connection id", async () => {
    const { fetchImpl } = stubFetch([{ data: { connectionId: "conn_other", projectId: "proj_1", environmentId: "env_1", title: "Wrong" }, observedAt: "t", freshness }]);
    await expect(createT3Adapter(fetchImpl).readProject({ connectionId: "conn_1", projectId: "proj_1" })).rejects.toMatchObject({ uiError: { code: "malformed_response" } });
  });

  it("accepts a detail response whose identity matches the request", async () => {
    const { fetchImpl } = stubFetch([{ data: { connectionId: "conn_1", projectId: "proj_1", environmentId: "env_1", title: "ega-house", workspaceRoot: "/srv/ega-house" }, observedAt: "t", freshness }]);
    const project = await createT3Adapter(fetchImpl).readProject({ connectionId: "conn_1", projectId: "proj_1" });
    expect(project.title).toBe("ega-house");
    expect(project.workspaceRoot).toBe("/srv/ega-house");
  });
});

describe("lifecycle", () => {
  it("starts OAuth with the endpoint and returns the consent result", async () => {
    const { fetchImpl, calls } = stubFetch([{ attemptId: "att_1", authorizationUrl: "https://studio.t3coderelay.com/authorize?x=1", expiresAt: "2026-10-12T09:10:00.000Z" }]);
    const started = await createT3Adapter(fetchImpl).startOAuth({ endpoint: "https://studio.t3coderelay.com/mcp" });
    expect(calls[0].url).toBe("/api/t3/oauth/start");
    expect(calls[0].init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ endpoint: "https://studio.t3coderelay.com/mcp" });
    expect(started.attemptId).toBe("att_1");
  });

  it("restarts OAuth against an existing connection id so no duplicate grant is made", async () => {
    const { fetchImpl, calls } = stubFetch([{ attemptId: "att_2", authorizationUrl: "https://studio.t3coderelay.com/authorize", expiresAt: null }]);
    const started = await createT3Adapter(fetchImpl).restartOAuth({ connectionId: "conn_1" });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ connectionId: "conn_1" });
    expect(started.expiresAt).toBeNull();
  });

  it("returns the verified environment from a refresh", async () => {
    const { fetchImpl, calls } = stubFetch([{ data: { environment: { environmentId: "env_1", label: "Studio", serverVersion: "1.2.3", platform: "linux/x64", metadata: null }, observedAt: "2026-10-12T10:00:00.000Z" } }]);
    const result = await createT3Adapter(fetchImpl).refresh({ connectionId: "conn_1" });
    expect(calls[0].url).toBe("/api/t3/connections/conn_1/refresh");
    expect(result.environment.serverVersion).toBe("1.2.3");
  });

  it("disconnects through the same-origin delete route", async () => {
    const { fetchImpl, calls } = stubFetch([{ connectionId: "conn_1", status: "disconnected" }]);
    await expect(createT3Adapter(fetchImpl).disconnect({ connectionId: "conn_1" })).resolves.toEqual({ connectionId: "conn_1", status: "disconnected" });
    expect(calls[0]).toMatchObject({ url: "/api/t3/connections/conn_1", init: { method: "DELETE" } });
  });
});

describe("consent destination policy", () => {
  it.each([
    "https://studio.t3coderelay.com/authorize",
    "https://t3coderelay.com/authorize",
    "https://eu.t3coderelay.com/authorize?client_id=1&state=2",
  ])("approves %s", (url) => expect(isApprovedAuthorizationUrl(url)).toBe(true));

  it.each([
    "http://studio.t3coderelay.com/authorize",
    "https://t3coderelay.com.evil.invalid/authorize",
    "https://evilt3coderelay.com/authorize",
    "https://user:pass@studio.t3coderelay.com/authorize",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %s", (url) => expect(isApprovedAuthorizationUrl(url)).toBe(false));
});

describe("error normalization", () => {
  it("returns a safe default for a non-adapter failure", () => {
    expect(toUiError(new Error("ECONNRESET 10.0.0.4:443"))).toEqual({ code: "unknown", message: "The T3 request could not be completed.", retryable: true });
  });
});

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    throw new Error("expected the call to reject");
  } catch (error) {
    return error;
  }
}

function syncError(run: () => unknown): unknown {
  try {
    run();
    throw new Error("expected the call to throw");
  } catch (error) {
    return error;
  }
}