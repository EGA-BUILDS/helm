"use node";

import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

const TRUSTED_DOMAIN = "t3coderelay.com";
const MAX_BODY = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;
const READ_SCOPE = "orchestration:read";
const TOOLS = new Set([
  "t3_environment_read", "orchestrator_capabilities", "t3_project_list",
  "t3_project_read", "t3_thread_list", "t3_thread_read",
]);

type Owner = { subject: string; issuer: string; revision: number };
type Json = Record<string, unknown>;
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

function encryptionKey(): Buffer {
  const encoded = process.env.T3_OAUTH_ENCRYPTION_KEY;
  if (!encoded) throw new Error("T3 OAuth encryption is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("T3 OAuth encryption is not configured");
  return key;
}
function encrypt(value: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}
function decrypt(value: string, purpose: string): string {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part!, "base64url"));
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) throw new Error("Stored credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (value: Buffer) => value.toString("base64url");

function validateUrl(value: string, endpoint = false): URL {
  if (value.length > 2048) throw new Error("Enter a valid T3 Connect URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid T3 Connect URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      !(url.hostname === TRUSTED_DOMAIN || url.hostname.endsWith(`.${TRUSTED_DOMAIN}`)) ||
      (endpoint && url.pathname !== "/mcp")) {
    throw new Error("Only trusted HTTPS T3 Connect MCP endpoints are supported");
  }
  return url;
}
function publicIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b! >= 64 && b! <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && (b === 0 || b === 2 || b === 88)) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0);
}
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  validateUrl(url.href);
  if (init?.redirect && init.redirect !== "manual" && init.redirect !== "error") throw new Error("Redirects are disabled");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const address = addresses.find((entry) => entry.family === 4 && publicIpv4(entry.address));
  if (!address) throw new Error("T3 endpoint did not resolve to a public address");
  const headers = new Headers(init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers));
  const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
  const bodySource = init?.body ?? (typeof input === "string" || input instanceof URL ? undefined : input.body);
  const body = typeof bodySource === "string" ? Buffer.from(bodySource) : bodySource instanceof URLSearchParams ? Buffer.from(bodySource.toString()) : undefined;
  const response = await new Promise<{ status: number; headers: Headers; stream: NodeJS.ReadableStream }>((resolve, reject) => {
    const req = httpsRequest(url, {
      method, headers: Object.fromEntries(headers.entries()), servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, 4),
    }, (res) => {
      let size = 0;
      const limited = res.pipe(new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > MAX_BODY) done(new Error("T3 response exceeded size limit"));
          else done(null, chunk);
        },
      }));
      limited.on("error", (error) => req.destroy(error));
      resolve({
        status: res.statusCode ?? 502,
        headers: new Headers(Object.entries(res.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]])),
        stream: limited,
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("T3 request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    else if (bodySource && typeof bodySource !== "string") reject(new Error("Unsupported request body"));
    req.end();
  });
  return new Response(Readable.toWeb(response.stream) as ReadableStream, { status: response.status, headers: response.headers });
}
async function json(response: Response): Promise<Json> {
  if (!response.ok) throw new Error(`T3 request failed (${response.status})`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error("T3 returned an invalid response");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("T3 returned an invalid response");
  return value as Json;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new Error(`T3 ${label} is unavailable`);
  return value;
}
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function nullableRecord(value: unknown): Json | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Json;
}
function projectView(value: unknown, environmentId: string, connectionId: string): Json {
  const project = object(value);
  const projectId = requiredString(project.id ?? project.projectId, "project id");
  const repository = object(project.repositoryIdentity);
  return {
    connectionId, projectId,
    environmentId, title: nullableString(project.title), status: project.deletedAt ? "deleted" : "active",
    workspaceRoot: nullableString(project.workspaceRoot), repositoryIdentity: nullableString(repository.canonicalKey),
    defaultModel: nullableString(object(project.defaultModelSelection).model),
  };
}
function threadView(value: unknown, environmentId: string, connectionId: string): Json {
  const thread = object(value);
  const threadId = requiredString(thread.threadId, "thread id");
  const projectId = requiredString(thread.projectId, "thread project");
  return {
    connectionId, threadId, projectId,
    environmentId, title: nullableString(thread.title), status: nullableString(thread.status),
    providerInstanceId: nullableString(thread.providerInstanceId), model: nullableString(thread.model),
    runtimeMode: nullableString(thread.runtimeMode), interactionMode: nullableString(thread.interactionMode),
    branch: nullableString(thread.branch), worktreePath: nullableString(thread.worktreePath),
    latestRunId: nullableString(thread.latestRunId), parentThreadId: nullableString(thread.parentThreadId),
    linkedPullRequest: nullableRecord(thread.linkedPullRequest), updatedAt: nullableString(thread.updatedAt),
  };
}
function catalogView(value: unknown): Json {
  const catalog = object(value);
  const providers = Array.isArray(catalog.providers) ? catalog.providers.map((entry) => {
    const provider = object(entry);
    const models = Array.isArray(provider.models) ? provider.models.map((entry) => {
      const model = object(entry);
      return { id: nullableString(model.id) ?? "", label: nullableString(model.label), options: Array.isArray(model.options) ? model.options : null };
    }) : null;
    return {
      providerInstanceId: nullableString(provider.providerInstanceId) ?? "", driverKind: nullableString(provider.driverKind),
      displayName: nullableString(provider.displayName), models,
      runtimeModes: Array.isArray(provider.runtimeModes) ? provider.runtimeModes : null,
      canRunChildTask: typeof provider.canRunChildTask === "boolean" ? provider.canRunChildTask : null,
      canRunCrossProviderChildTask: typeof provider.canRunCrossProviderChildTask === "boolean" ? provider.canRunCrossProviderChildTask : null,
      authenticationStatus: null, availability: null,
      constraints: Array.isArray(provider.constraints) ? provider.constraints.filter((item): item is string => typeof item === "string") : null,
    };
  }) : [];
  const features = object(catalog.features);
  const keys = ["appOwnedSubagents", "asyncPolling", "cancellation", "batchThreadCreation", "threadManagement", "incrementalThreadRead", "scheduledTasks"];
  const featureView = Object.fromEntries(keys.map((key) => [key, typeof features[key] === "boolean" ? features[key] : null]));
  return {
    providers, features: { ...featureView, maxBatchThreads: typeof features.maxBatchThreads === "number" ? features.maxBatchThreads : null },
    runtimeMode: nullableString(catalog.runtimeMode), interactionMode: nullableString(catalog.interactionMode),
    parentThreadId: nullableString(catalog.parentThreadId), inheritedProviderInstanceId: nullableString(catalog.inheritedProviderInstanceId),
    inheritedModel: nullableString(catalog.inheritedModel),
  };
}
function threadDetailView(value: unknown, environmentId: string, connectionId: string): Json {
  const detail = object(value);
  const items = Array.isArray(detail.items) ? detail.items.map((entry) => {
    const item = object(entry);
    return {
      id: nullableString(item.itemId) ?? "", position: typeof item.position === "number" ? item.position : 0,
      kind: nullableString(item.type), text: nullableString(item.text), createdAt: nullableString(item.updatedAt),
      truncated: item.textTruncated === true, nextTextOffset: typeof item.nextTextOffset === "number" ? item.nextTextOffset : null,
    };
  }) : [];
  const runs = Array.isArray(detail.recentRuns) ? detail.recentRuns.map((entry) => {
    const run = object(entry);
    return {
      runId: nullableString(run.runId) ?? "", ordinal: typeof run.ordinal === "number" ? run.ordinal : null,
      status: nullableString(run.status), providerInstanceId: nullableString(run.providerInstanceId), model: nullableString(run.model),
      requestedAt: nullableString(run.requestedAt), startedAt: nullableString(run.startedAt), completedAt: nullableString(run.completedAt),
    };
  }) : [];
  return {
    thread: threadView(detail.thread, environmentId, connectionId), items, recentRuns: runs,
    nextPosition: typeof detail.nextPosition === "number" ? detail.nextPosition : null, hasMore: detail.hasMore === true,
  };
}
async function discover(endpoint: URL) {
  const resource = endpoint.href;
  const resourceMetadata = await json(await safeFetch(new URL("/.well-known/oauth-protected-resource/mcp", endpoint.origin)));
  if (resourceMetadata.resource !== resource || !Array.isArray(resourceMetadata.authorization_servers) ||
      resourceMetadata.authorization_servers.length !== 1) throw new Error("T3 resource discovery did not match this endpoint");
  const issuer = requiredString(resourceMetadata.authorization_servers[0], "issuer");
  if (new URL(issuer).origin !== endpoint.origin) throw new Error("T3 OAuth issuer is not trusted");
  const metadata = await json(await safeFetch(new URL("/.well-known/oauth-authorization-server", issuer)));
  if (metadata.issuer !== issuer) throw new Error("T3 OAuth issuer did not match discovery");
  const authorizationEndpoint = requiredString(metadata.authorization_endpoint, "authorization endpoint");
  const tokenEndpoint = requiredString(metadata.token_endpoint, "token endpoint");
  const registrationEndpoint = requiredString(metadata.registration_endpoint, "registration endpoint");
  for (const item of [authorizationEndpoint, tokenEndpoint, registrationEndpoint]) {
    if (new URL(item).origin !== endpoint.origin) throw new Error("T3 OAuth endpoint is not trusted");
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256") ||
      !Array.isArray(metadata.grant_types_supported) || !metadata.grant_types_supported.includes("authorization_code")) {
    throw new Error("T3 OAuth does not support the required authorization flow");
  }
  return { issuer, resource, authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}
function callbackUri(): string {
  const base = process.env.HELM_APP_URL;
  if (!base) throw new Error("Helm callback URL is not configured");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Helm callback URL is not configured");
  return new URL("/api/t3/callback", url).href;
}
async function toolCall(endpoint: string, token: string, tool: string, args: Json = {}): Promise<Json> {
  if (!TOOLS.has(tool)) throw new Error("This T3 operation is not available");
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: safeFetch,
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    redirectPolicy: "same-origin",
  });
  const client = new Client({ name: "helm-readonly", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError) throw new Error("T3 could not complete the read");
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Json;
    const text = result.content.find((item) => item.type === "text")?.text;
    if (!text || text.length > MAX_BODY) throw new Error("T3 returned an invalid read result");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("T3 returned an invalid read result");
    return parsed as Json;
  } finally { await client.close().catch(() => undefined); }
}

export const start = action({
  args: { endpoint: v.string(), redirectUri: v.optional(v.string()), connectionId: v.optional(v.id("t3Connections")) },
  returns: v.object({ attemptId: v.string(), authorizationUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    const endpoint = validateUrl(args.endpoint, true);
    if (args.connectionId) {
      const existing = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner), connectionId: args.connectionId, now: Date.now(),
      });
      if (!existing || existing.endpoint !== endpoint.href) throw new Error("Reconnect must target the existing T3 endpoint");
    }
    const meta = await discover(endpoint);
    const redirectUri = callbackUri();
    if (args.redirectUri && args.redirectUri !== redirectUri) throw new Error("OAuth callback URI mismatch");
    const reg = await json(await safeFetch(meta.registrationEndpoint, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Helm", redirect_uris: [redirectUri], grant_types: ["authorization_code"],
        response_types: ["code"], token_endpoint_auth_method: "none",
      }),
    }));
    const clientId = requiredString(reg.client_id, "client registration");
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const attemptId = b64url(randomBytes(18));
    const createdAt = Date.now();
    const expiresAt = createdAt + 10 * 60_000;
    await ctx.runMutation(internal.t3ConnectionsStore.createAttempt, {
      ...storeOwner(owner), attemptId, endpoint: endpoint.href, issuer: meta.issuer, resource: meta.resource,
      authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint,
      registrationEndpoint: meta.registrationEndpoint, clientId, redirectUri, stateHash: digest(state),
      verifierCiphertext: encrypt(verifier, `pkce:${owner.issuer}:${owner.subject}:${attemptId}`),
      connectionId: args.connectionId ?? null, createdAt, expiresAt,
    });
    const authorization = new URL(meta.authorizationEndpoint);
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("scope", READ_SCOPE);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("resource", meta.resource);
    return { attemptId, authorizationUrl: authorization.href, expiresAt };
  },
});

export const callback = action({
  args: { state: v.string(), code: v.optional(v.string()), error: v.optional(v.string()), issuer: v.optional(v.string()) },
  returns: v.object({ connectionId: v.union(v.id("t3Connections"), v.null()), status: v.string() }),
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(args.state) || (args.code && args.code.length > 4096) ||
        (args.error && args.error.length > 128) || (args.issuer && args.issuer.length > 2048)) {
      throw new Error("OAuth callback is invalid");
    }
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    const now = Date.now();
    const pending = await ctx.runMutation(internal.t3ConnectionsStore.consumeAttempt, { ...storeOwner(owner), stateHash: digest(args.state), now });
    if (!pending) throw new Error("OAuth attempt is invalid or expired");
    if (args.error) {
      await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status: "denied", at: now });
      return { connectionId: null, status: "denied" };
    }
    try {
      if (!args.code || args.issuer !== pending.issuer) throw new Error("OAuth callback is invalid");
      const verifier = decrypt(pending.verifierCiphertext, `pkce:${owner.issuer}:${owner.subject}:${pending.attemptId}`);
      const response = await json(await safeFetch(pending.tokenEndpoint, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: args.code, redirect_uri: pending.redirectUri,
          client_id: pending.clientId, code_verifier: verifier, resource: pending.resource }).toString(),
      }));
      const accessToken = requiredString(response.access_token, "access token");
      const expiresIn = typeof response.expires_in === "number" && Number.isFinite(response.expires_in) ? response.expires_in : 3600;
      if (expiresIn <= 0 || expiresIn > 31_536_000) throw new Error("T3 returned an invalid token lifetime");
      if (typeof response.scope !== "string" || !response.scope.split(/\s+/).includes(READ_SCOPE) || response.scope.split(/\s+/).some((scope) => scope !== READ_SCOPE)) throw new Error("T3 granted permissions beyond read-only access");
      const environment = await toolCall(pending.endpoint, accessToken, "t3_environment_read");
      const connectionId = await ctx.runMutation(internal.t3ConnectionsStore.saveConnection, {
        ...storeOwner(owner), connectionId: pending.connectionId, endpoint: pending.endpoint, issuer: pending.issuer,
        resource: pending.resource, clientId: pending.clientId,
        environmentId: requiredString(environment.environmentId, "environment id"),
        environmentLabel: requiredString(environment.label, "environment label"),
        serverVersion: requiredString(environment.serverVersion, "server version"),
        platform: requiredString(environment.platform, "platform"),
        tokenCiphertext: encrypt(accessToken, `token:${owner.issuer}:${owner.subject}:${pending.endpoint}`),
        expiresAt: now + expiresIn * 1000, at: now,
      });
      await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status: "connected", at: Date.now() });
      return { connectionId, status: "connected" };
    } catch {
      await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status: "failed", at: Date.now() });
      throw new Error("T3 connection could not be completed; existing connection remains unchanged");
    }
  },
});

export const list = action({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    return await ctx.runQuery(internal.t3ConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
  },
});

export const read = action({
  args: { connectionId: v.id("t3Connections"), operation: v.string(), input: v.optional(v.any()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    const row = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: args.connectionId, now: Date.now() });
    if (!row || row.status === "disconnected") throw new Error("T3 connection is unavailable");
    if (row.status === "expired" || row.status === "reauthorizationRequired") throw new Error("T3 connection has expired; reconnect it to continue");
    const token = decrypt(row.tokenCiphertext, `token:${owner.issuer}:${owner.subject}:${row.endpoint}`);
    const input = (args.input && typeof args.input === "object" ? args.input : {}) as Json;
    const op = args.operation;
    if (op === "environment") {
      const value = await toolCall(row.endpoint, token, "t3_environment_read");
      return { environmentId: requiredString(value.environmentId, "environment id"), label: nullableString(value.label), serverVersion: nullableString(value.serverVersion), platform: nullableString(value.platform) };
    }
    if (op === "capabilities") return {
      ...catalogView(await toolCall(row.endpoint, token, "orchestrator_capabilities")),
      freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false },
    };
    if (op === "project") return projectView(await toolCall(row.endpoint, token, "t3_project_read", { projectId: requiredString(input.projectId, "project id") }), row.environmentId, String(row.connectionId));
    if (op === "projects") {
      const projects = new Map<string, Json>();
      const cursors = new Set<number>();
      let cursor: number | null = null;
      const deadline = Date.now() + 30_000;
      for (let page = 0; page < 100; page++) {
        if (Date.now() >= deadline) throw new Error("T3 project listing exceeded its time limit; retry later");
        const result = await toolCall(row.endpoint, token, "t3_project_list", { cursor, limit: 100 });
        if (!Array.isArray(result.projects)) throw new Error("T3 returned an invalid project page");
        for (const project of result.projects) {
          const view = projectView(project, row.environmentId, String(row.connectionId));
          projects.set(String(view.projectId), view);
        }
        if (Buffer.byteLength(JSON.stringify([...projects.values()]), "utf8") > 4 * MAX_BODY) throw new Error("T3 project listing exceeded its response limit; narrow the request or retry later");
        const next = result.nextCursor;
        if (next === null || next === undefined) return { items: [...projects.values()], nextCursor: null, total: projects.size, freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false } };
        if (typeof next !== "number" || !Number.isInteger(next) || next < 0 || cursors.has(next)) throw new Error("T3 returned an invalid page cursor");
        cursors.add(next);
        cursor = next;
      }
      throw new Error("T3 project listing exceeded the supported page limit; narrow the request or retry later");
    }
    if (op === "threads") {
      const cursor = input.cursor;
      const limit = input.limit ?? 50;
      if (cursor !== undefined && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) throw new Error("T3 page cursor is invalid");
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("T3 page limit is invalid");
      if (input.titleContains !== undefined && (typeof input.titleContains !== "string" || input.titleContains.length > 256)) throw new Error("T3 thread filter is invalid");
      if (input.statuses !== undefined && (!Array.isArray(input.statuses) || input.statuses.length > 10 || input.statuses.some((status) => typeof status !== "string" || status.length > 64))) throw new Error("T3 thread filter is invalid");
      const result = await toolCall(row.endpoint, token, "t3_thread_list", {
        projectId: requiredString(input.projectId, "project id"), cursor, limit,
        titleContains: input.titleContains, statuses: input.statuses,
      });
      return {
        items: Array.isArray(result.threads) ? result.threads.map((thread) => threadView(thread, row.environmentId, String(row.connectionId))) : [],
        nextCursor: typeof result.nextCursor === "number" ? result.nextCursor : null,
        total: typeof result.total === "number" ? result.total : null,
        freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false },
      };
    }
    if (op === "thread") {
      const afterPosition = input.afterPosition;
      const limit = input.limit ?? 100;
      if (afterPosition !== undefined && (typeof afterPosition !== "number" || !Number.isInteger(afterPosition) || afterPosition < 0)) throw new Error("T3 thread position is invalid");
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("T3 thread page limit is invalid");
      if (input.itemId !== undefined && (typeof input.itemId !== "string" || input.itemId.length > 256)) throw new Error("T3 thread item is invalid");
      if (input.textOffset !== undefined && (typeof input.textOffset !== "number" || !Number.isInteger(input.textOffset) || input.textOffset < 0)) throw new Error("T3 text offset is invalid");
      const result = await toolCall(row.endpoint, token, "t3_thread_read", {
        threadId: requiredString(input.threadId, "thread id"), afterPosition, view: "activity",
        limit, itemId: input.itemId, textOffset: input.textOffset,
      });
      return { ...threadDetailView(result, row.environmentId, String(row.connectionId)), freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false } };
    }
    throw new Error("This T3 read operation is not available");
  },
});

export const disconnect = action({
  args: { connectionId: v.id("t3Connections") }, returns: v.boolean(),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    return await ctx.runMutation(internal.t3ConnectionsStore.disconnect, { ...storeOwner(owner), connectionId: args.connectionId, at: Date.now() });
  },
});

export const refresh = action({
  args: { connectionId: v.id("t3Connections") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(api.t3ConnectionsStore.ownerContext, {});
    const now = Date.now();
    const row = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: args.connectionId, now });
    if (!row || row.status === "disconnected") throw new Error("T3 connection is unavailable");
    if (row.status === "expired" || row.status === "reauthorizationRequired") {
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, { ...storeOwner(owner), connectionId: args.connectionId, at: now, status: "reauthorizationRequired" });
      throw new Error("T3 connection has expired; reconnect it to continue");
    }
    const token = decrypt(row.tokenCiphertext, `token:${owner.issuer}:${owner.subject}:${row.endpoint}`);
    try {
      const environment = await toolCall(row.endpoint, token, "t3_environment_read");
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, { ...storeOwner(owner), connectionId: args.connectionId, at: Date.now(), status: "connected" });
      return {
        environment: { environmentId: nullableString(environment.environmentId), label: nullableString(environment.label), serverVersion: nullableString(environment.serverVersion), platform: nullableString(environment.platform) },
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /T3 request failed \((401|403)\)/.test(message)
        ? "reauthorizationRequired" as const : "unreachable" as const;
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, { ...storeOwner(owner), connectionId: args.connectionId, at: Date.now(), status });
      throw new Error(status === "reauthorizationRequired" ? "T3 authorization was revoked; reconnect to continue" : "T3 environment could not be reached");
    }
  },
});
