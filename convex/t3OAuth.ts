"use node";

import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { lookup } from "node:dns/promises";
import { pinnedIpv4Lookup } from "./lib/t3PinnedLookup";
import { checkT3Endpoint } from "./lib/t3EndpointPolicy";
import { hasExactT3Scopes, describeT3CallbackFailure, classifyT3ProviderError, createT3CallbackReporter, recordT3ProviderError, type T3CallbackStage } from "./lib/t3OAuthCallbackSafety";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { v, type Infer } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MAX_BODY = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;
const READ_SCOPE = "orchestration:read";
/**
 * Scope for the separately-authorised operate grant (EGA-681). Requested ONLY
 * on the operate consent path; the read-only path below never sees it.
 */
const OPERATE_SCOPE = "orchestration:read orchestration:operate";
const TOOLS = new Set([
  "t3_environment_read", "orchestrator_capabilities", "t3_project_list",
  "t3_project_read", "t3_thread_list", "t3_thread_read",
]);
/**
 * Write allowlist, usable ONLY through the operate-scoped path with an
 * `access: "operate"` connection. The write allowlist holds exactly three
 * tools: `t3_thread_launch` (EGA-681), `t3_thread_send` (EGA-764) and
 * `t3_thread_interrupt` (EGA-765). The read path (`toolCall` + `TOOLS` above) can never
 * reach it — `operateToolCall` refuses any other tool AND any non-operate
 * access before any network call is made.
 */
const WRITE_TOOLS = new Set(["t3_thread_launch", "t3_thread_send", "t3_thread_interrupt"]);
const nullableText = v.union(v.string(), v.null());
const freshness = v.object({ source: v.literal("backend"), observedAt: v.string(), stale: v.boolean() });
const projectRecord = v.object({
  connectionId: v.string(), projectId: v.string(), environmentId: v.string(), title: nullableText,
  status: nullableText, workspaceRoot: nullableText, repositoryIdentity: nullableText, defaultModel: nullableText,
});
const threadRecord = v.object({
  connectionId: v.string(), threadId: v.string(), projectId: v.string(), environmentId: v.string(),
  title: nullableText, status: nullableText, providerInstanceId: nullableText, model: nullableText,
  runtimeMode: nullableText, interactionMode: nullableText, branch: nullableText, worktreePath: nullableText,
  latestRunId: nullableText, parentThreadId: nullableText,
  linkedPullRequest: v.union(v.record(v.string(), v.any()), v.null()), updatedAt: nullableText,
});
const pageFreshness = { freshness };
const readReturns = v.union(
  v.object({ environmentId: v.string(), label: nullableText, serverVersion: nullableText, platform: nullableText, metadata: v.union(v.record(v.string(), v.any()), v.null()) }),
  v.object({
    providers: v.array(v.object({
      providerInstanceId: v.string(), driverKind: nullableText, displayName: nullableText,
      models: v.union(v.array(v.object({ id: v.string(), label: nullableText, options: v.union(v.array(v.any()), v.null()) })), v.null()),
      runtimeModes: v.union(v.array(v.any()), v.null()), canRunChildTask: v.union(v.boolean(), v.null()),
      canRunCrossProviderChildTask: v.union(v.boolean(), v.null()), authenticationStatus: v.null(), availability: v.null(),
      constraints: v.union(v.array(v.string()), v.null()),
    })),
    features: v.object({
      appOwnedSubagents: v.union(v.boolean(), v.null()), asyncPolling: v.union(v.boolean(), v.null()),
      cancellation: v.union(v.boolean(), v.null()), batchThreadCreation: v.union(v.boolean(), v.null()),
      threadManagement: v.union(v.boolean(), v.null()), incrementalThreadRead: v.union(v.boolean(), v.null()),
      scheduledTasks: v.union(v.boolean(), v.null()), maxBatchThreads: v.union(v.number(), v.null()),
    }), runtimeMode: nullableText, interactionMode: nullableText, parentThreadId: nullableText,
    inheritedProviderInstanceId: nullableText, inheritedModel: nullableText, ...pageFreshness,
  }),
  projectRecord,
  v.object({ items: v.array(projectRecord), nextCursor: v.union(v.number(), v.null()), total: v.union(v.number(), v.null()), ...pageFreshness }),
  v.object({ items: v.array(threadRecord), nextCursor: v.union(v.number(), v.null()), total: v.union(v.number(), v.null()), ...pageFreshness }),
  v.object({
    thread: threadRecord,
    items: v.array(v.object({ id: v.string(), position: v.number(), kind: nullableText, text: nullableText, createdAt: nullableText, truncated: v.boolean(), nextTextOffset: v.union(v.number(), v.null()) })),
    recentRuns: v.array(v.object({ runId: v.string(), ordinal: v.union(v.number(), v.null()), status: nullableText, providerInstanceId: nullableText, model: nullableText, requestedAt: nullableText, startedAt: nullableText, completedAt: nullableText })),
    nextPosition: v.union(v.number(), v.null()), hasMore: v.boolean(), ...pageFreshness,
  }),
);
type T3ReadResult = Infer<typeof readReturns>;

type Owner = { subject: string; issuer: string; revision: number };
type Json = Record<string, unknown>;
const storeOwner = (owner: Owner) => ({ subject: owner.subject, ownerIssuer: owner.issuer, revision: owner.revision });

function encryptionKey(version = process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION ?? "v1"): Buffer {
  if (!/^v[1-9][0-9]{0,2}$/u.test(version)) throw new Error("T3 OAuth encryption is not configured");
  const encoded = process.env[`T3_OAUTH_ENCRYPTION_KEY_${version.toUpperCase()}`] ??
    (version === "v1" ? process.env.T3_OAUTH_ENCRYPTION_KEY : undefined);
  if (!encoded) throw new Error("T3 OAuth encryption is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("T3 OAuth encryption is not configured");
  return key;
}
function encrypt(value: string, purpose: string): string {
  const version = process.env.T3_OAUTH_ENCRYPTION_KEY_VERSION ?? "v1";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(version), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [version, iv, cipher.getAuthTag(), ciphertext].map((part) => typeof part === "string" ? part : part.toString("base64url")).join(".");
}
function decrypt(value: string, purpose: string): string {
  const parts = value.split(".");
  const versioned = parts.length === 4 && /^v[1-9][0-9]{0,2}$/u.test(parts[0] ?? "");
  const version = versioned ? parts.shift()! : "v1";
  if (parts.length !== 3) throw new Error("Stored credential is invalid");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part!, "base64url"));
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) throw new Error("Stored credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(version), iv);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (value: Buffer) => value.toString("base64url");

/**
 * Enforce the shared trusted-endpoint policy.
 *
 * The rules live in `convex/lib/t3EndpointPolicy.ts` and are bundled by the
 * browser too, so the client's early feedback cannot disagree with this check.
 * The two error messages are preserved verbatim: `safeFailure` classifies on
 * them, and they are the only text that reaches the owner.
 */
function validateUrl(value: string, endpoint = false): URL {
  const result = checkT3Endpoint(value, { requireMcpPath: endpoint });
  if (result.ok) return result.url;
  if (result.reason === "too_long" || result.reason === "malformed") {
    throw new Error("Enter a valid T3 Connect URL");
  }
  throw new Error("Only trusted HTTPS T3 Connect MCP endpoints are supported");
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
async function safeFetch(input: RequestInfo | URL, init?: RequestInit, beforeRequest?: () => Promise<unknown>): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  validateUrl(url.href);
  if (init?.redirect && init.redirect !== "manual" && init.redirect !== "error") throw new Error("Redirects are disabled");
  await beforeRequest?.();
  const lookupTimeoutMs = REQUEST_TIMEOUT_MS - (Date.now() - startedAt);
  if (lookupTimeoutMs <= 0) throw new Error("T3 request timed out");
  let lookupDeadline: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      lookupDeadline = setTimeout(() => reject(new Error("T3 request timed out")), lookupTimeoutMs);
    }),
  ]).finally(() => clearTimeout(lookupDeadline));
  const address = addresses.find((entry) => entry.family === 4 && publicIpv4(entry.address));
  if (!address) throw new Error("T3 endpoint did not resolve to a public address");
  const timeoutMs = REQUEST_TIMEOUT_MS - (Date.now() - startedAt);
  if (timeoutMs <= 0) throw new Error("T3 request timed out");
  const headers = new Headers(init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers));
  const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
  const bodySource = init?.body ?? (typeof input === "string" || input instanceof URL ? undefined : input.body);
  const body = typeof bodySource === "string" ? Buffer.from(bodySource) : bodySource instanceof URLSearchParams ? Buffer.from(bodySource.toString()) : undefined;
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });

  const response = await new Promise<{ status: number; headers: Headers; stream: Readable }>((resolve, reject) => {
    const req = httpsRequest(url, {
      method, headers: requestHeaders, servername: url.hostname,
      lookup: pinnedIpv4Lookup(address.address),
    }, (res) => {
      let size = 0;
      const limited = res.pipe(new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > MAX_BODY) done(new Error("T3 response exceeded size limit"));
          else done(null, chunk);
        },
      }));
      const clearDeadline = () => clearTimeout(deadline);
      limited.once("end", clearDeadline);
      limited.once("error", clearDeadline);
      limited.on("error", (error) => req.destroy(error));
      resolve({
        status: res.statusCode ?? 502,
        // Explicit tuple element type: without it the empty `[]` branch widens
        // the inference to `string[][]`, which `HeadersInit` rejects. The
        // annotation erases at runtime; the produced headers are unchanged.
        headers: new Headers(Object.entries(res.headers).flatMap<[string, string]>(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]])),
        stream: limited,
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("T3 request timed out")), timeoutMs);
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
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
function requiredObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`T3 returned an invalid ${label}`);
  return value as Json;
}
function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function nullableCursor(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function nullableCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function requiredPosition(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("T3 returned an invalid text field");
  return value;
}
function platformLabel(value: unknown): string {
  if (typeof value === "string") return requiredString(value, "platform");
  const platform = requiredObject(value, "platform");
  const os = requiredString(platform.os, "platform operating system");
  const arch = requiredString(platform.arch, "platform architecture");
  return `${os}/${arch}`;
}
function nullableRecord(value: unknown): Json | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("T3 returned an invalid object field");
  return value as Json;
}
function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  return requiredBoolean(value, label);
}
function nullableArray(value: unknown, label: string): unknown[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`T3 returned an invalid ${label}`);
  return value;
}
function projectView(value: unknown, environmentId: string, connectionId: string) {
  const project = requiredObject(value, "project");
  const projectId = requiredString(project.id ?? project.projectId, "project id");
  const repository = object(project.repositoryIdentity);
  return {
    connectionId, projectId,
    environmentId, title: nullableString(project.title), status: nullableString(project.status),
    workspaceRoot: nullableString(project.workspaceRoot), repositoryIdentity: nullableString(repository.canonicalKey),
    defaultModel: nullableString(object(project.defaultModelSelection).model),
  };
}
function threadView(value: unknown, environmentId: string, connectionId: string, fallbackProjectId?: string) {
  const thread = requiredObject(value, "thread");
  const threadId = requiredString(thread.threadId, "thread id");
  const projectId = requiredString(thread.projectId ?? fallbackProjectId, "thread project");
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
function catalogView(value: unknown) {
  const catalog = requiredObject(value, "capabilities response");
  const providers = requiredArray(catalog.providers, "capabilities providers").map((entry) => {
    const provider = requiredObject(entry, "provider");
    const models = requiredArray(provider.models, "provider models").map((entry) => {
      const model = requiredObject(entry, "model");
      return { id: requiredString(model.id, "model id"), label: nullableString(model.label), options: nullableArray(model.options, "model options") };
    });
    return {
      providerInstanceId: requiredString(provider.providerInstanceId, "provider id"), driverKind: nullableString(provider.driverKind),
      displayName: nullableString(provider.displayName), models,
      runtimeModes: nullableArray(provider.runtimeModes, "provider runtime modes")?.map((mode) => requiredString(mode, "provider runtime mode")) ?? null,
      canRunChildTask: nullableBoolean(provider.canRunChildTask, "child task capability"),
      canRunCrossProviderChildTask: nullableBoolean(provider.canRunCrossProviderChildTask, "cross-provider child task capability"),
      authenticationStatus: null, availability: null,
      constraints: nullableArray(provider.constraints, "provider constraints")?.map((item) => requiredString(item, "provider constraint")) ?? null,
    };
  });
  const features = requiredObject(catalog.features, "capabilities features");
  const featureView = {
    appOwnedSubagents: requiredBoolean(features.appOwnedSubagents, "app-owned subagents"),
    asyncPolling: requiredBoolean(features.asyncPolling, "async polling"),
    cancellation: requiredBoolean(features.cancellation, "cancellation"),
    batchThreadCreation: requiredBoolean(features.batchThreadCreation, "batch thread creation"),
    threadManagement: requiredBoolean(features.threadManagement, "thread management"),
    incrementalThreadRead: requiredBoolean(features.incrementalThreadRead, "incremental thread read"),
    scheduledTasks: requiredBoolean(features.scheduledTasks, "scheduled tasks"),
  };
  if (features.maxBatchThreads !== null && features.maxBatchThreads !== undefined &&
      (typeof features.maxBatchThreads !== "number" || !Number.isSafeInteger(features.maxBatchThreads) || features.maxBatchThreads < 0)) {
    throw new Error("T3 returned an invalid batch thread limit");
  }
  return {
    providers, features: { ...featureView, maxBatchThreads: typeof features.maxBatchThreads === "number" ? features.maxBatchThreads : null },
    runtimeMode: nullableString(catalog.runtimeMode), interactionMode: nullableString(catalog.interactionMode),
    parentThreadId: nullableString(catalog.parentThreadId), inheritedProviderInstanceId: nullableString(catalog.inheritedProviderInstanceId),
    inheritedModel: nullableString(catalog.inheritedModel),
  };
}
function threadDetailView(value: unknown, environmentId: string, connectionId: string) {
  const detail = requiredObject(value, "thread detail");
  const items = requiredArray(detail.items, "thread items").map((entry) => {
    const item = requiredObject(entry, "thread item");
    return {
      id: requiredString(item.itemId, "thread item id"), position: requiredPosition(item.position, "thread item position"),
      kind: nullableString(item.type), text: nullableString(item.text), createdAt: nullableString(item.updatedAt),
      truncated: requiredBoolean(item.textTruncated, "text truncation flag"),
      nextTextOffset: item.nextTextOffset === null || item.nextTextOffset === undefined ? null : requiredPosition(item.nextTextOffset, "text offset"),
    };
  });
  const runs = requiredArray(detail.recentRuns, "thread runs").map((entry) => {
    const run = requiredObject(entry, "thread run");
    return {
      runId: requiredString(run.runId, "run id"), ordinal: nullableCount(run.ordinal, "run ordinal"),
      status: nullableString(run.status), providerInstanceId: nullableString(run.providerInstanceId), model: nullableString(run.model),
      requestedAt: nullableString(run.requestedAt), startedAt: nullableString(run.startedAt), completedAt: nullableString(run.completedAt),
    };
  });
  if (typeof detail.hasMore !== "boolean") throw new Error("T3 returned an invalid thread detail pagination state");
  return {
    thread: threadView(detail.thread, environmentId, connectionId), items, recentRuns: runs,
    nextPosition: nullableCursor(detail.nextPosition, "thread detail cursor"), hasMore: detail.hasMore,
  };
}
async function discover(endpoint: URL, beforeRequest: () => Promise<unknown>) {
  const resource = endpoint.href;
  const resourceMetadata = await json(await safeFetch(new URL("/.well-known/oauth-protected-resource/mcp", endpoint.origin), undefined, beforeRequest));
  if (resourceMetadata.resource !== resource || !Array.isArray(resourceMetadata.authorization_servers) ||
      resourceMetadata.authorization_servers.length !== 1) throw new Error("T3 resource discovery did not match this endpoint");
  const issuer = requiredString(resourceMetadata.authorization_servers[0], "issuer");
  if (new URL(issuer).origin !== endpoint.origin) throw new Error("T3 OAuth issuer is not trusted");
  const metadata = await json(await safeFetch(new URL("/.well-known/oauth-authorization-server", issuer), undefined, beforeRequest));
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
async function toolCall(endpoint: string, token: string, tool: string, args: Json = {}, beforeRequest: () => Promise<unknown> = async () => undefined): Promise<Json> {
  if (!TOOLS.has(tool)) throw new Error("This T3 operation is not available");
  return rawToolCall(endpoint, token, tool, args, beforeRequest);
}

/**
 * Operate-scoped tool call (EGA-681). The access check runs FIRST, before the
 * MCP transport is constructed or any byte is sent: a `read-only` connection
 * can never reach a write tool through this path. Only the three allowlisted
 * write tools are reachable; everything else is refused with the same fixed
 * message.
 */
export async function operateToolCall(
  endpoint: string,
  token: string,
  access: string,
  tool: string,
  args: Json = {},
  beforeRequest: () => Promise<unknown> = async () => undefined,
): Promise<Json> {
  if (access !== "operate") throw new Error("T3 operate access is required for this operation");
  if (!WRITE_TOOLS.has(tool)) throw new Error("This T3 operation is not available");
  return rawToolCall(endpoint, token, tool, args, beforeRequest);
}

/** Decrypt a stored T3 token. Used by the read path here and by the operate-scoped launch path. */
export function decryptStoredToken(ciphertext: string, owner: { issuer: string; subject: string }, endpoint: string): string {
  return decrypt(ciphertext, `token:${owner.issuer}:${owner.subject}:${endpoint}`);
}

async function rawToolCall(endpoint: string, token: string, tool: string, args: Json = {}, beforeRequest: () => Promise<unknown> = async () => undefined): Promise<Json> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: (input, init) => safeFetch(input, init, beforeRequest),
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    redirectPolicy: "same-origin",
  });
  const client = new Client({ name: "helm-readonly", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError) throw new Error("T3 could not complete the read");
    if (result.structuredContent != null) {
      return requiredObject(
        result.structuredContent,
        "structured tool result",
      );
    }

    if (!Array.isArray(result.content)) {
      throw new Error("T3 returned an invalid read result");
    }

    const content: unknown[] = result.content;
    const textItem = content
      .map((item) => requiredObject(item, "tool content item"))
      .find(
        (item) =>
          item.type === "text" &&
          typeof item.text === "string",
      );
    const text = textItem?.text;

    if (
      typeof text !== "string" ||
      text.length === 0 ||
      text.length > MAX_BODY
    ) {
      throw new Error("T3 returned an invalid read result");
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("T3 returned an invalid read result");
    return parsed as Json;
  } finally { await client.close().catch(() => undefined); }
}

export const start = action({
  args: { endpoint: v.optional(v.string()), redirectUri: v.optional(v.string()), connectionId: v.optional(v.id("t3Connections")), access: v.optional(v.union(v.literal("read-only"), v.literal("operate"))) },
  returns: v.object({ attemptId: v.string(), authorizationUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    // Absent means the v0.1 read-only grant: every existing caller keeps
    // requesting exactly `orchestration:read`.
    const requestedAccess = args.access ?? "read-only";
    const requestedScope = requestedAccess === "operate" ? OPERATE_SCOPE : READ_SCOPE;
    let endpoint: URL;
    let expectedConnectionCredentialVersion: number | null = null;
    if (args.connectionId) {
      const existing = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner), connectionId: args.connectionId, now: Date.now(),
      });
      if (!existing) throw new Error("Reconnect must target an existing T3 connection");
      endpoint = validateUrl(args.endpoint ?? existing.endpoint, true);
      if (existing.endpoint !== endpoint.href) throw new Error("Reconnect must target the existing T3 endpoint");
      expectedConnectionCredentialVersion = existing.credentialVersion;
    } else {
      if (!args.endpoint) throw new Error("A T3 endpoint is required for a new connection");
      endpoint = validateUrl(args.endpoint, true);
      const existing = await ctx.runQuery(internal.t3ConnectionsStore.listConnections, {
        ...storeOwner(owner), now: Date.now(),
      });
      if (existing.some((row) => row.access === requestedAccess)) {
        if (requestedAccess === "operate") {
          throw new Error("An operate T3 connection already exists; reconnect or disconnect it first");
        }
        throw new Error("A T3 connection already exists; reconnect or disconnect it first");
      }
    }
    const meta = await discover(endpoint, assertOwnerCurrent);
    const redirectUri = callbackUri();
    if (args.redirectUri && args.redirectUri !== redirectUri) throw new Error("OAuth callback URI mismatch");
    const reg = await json(await safeFetch(meta.registrationEndpoint, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Helm", redirect_uris: [redirectUri], grant_types: ["authorization_code"],
        response_types: ["code"], token_endpoint_auth_method: "none",
      }),
    }, assertOwnerCurrent));
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
      connectionId: args.connectionId ?? null, expectedConnectionCredentialVersion, access: requestedAccess, createdAt, expiresAt,
    });
    const authorization = new URL(meta.authorizationEndpoint);
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("scope", requestedScope);
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
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectionId: Id<"t3Connections"> | null;
    status: string;
  }> => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(args.state) ||
        (args.code !== undefined && (args.code.length === 0 || args.code.length > 4096)) ||
        (args.error !== undefined && (args.error.length === 0 || args.error.length > 128)) ||
        (args.issuer && args.issuer.length > 2048) || (args.code !== undefined) === (args.error !== undefined)) {
      throw new Error("OAuth callback is invalid");
    }
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const now = Date.now();
    const pending = await ctx.runMutation(internal.t3ConnectionsStore.consumeAttempt, { ...storeOwner(owner), stateHash: digest(args.state), now });
    if (!pending) throw new Error("OAuth attempt is invalid or expired");
    if ("expired" in pending) return { connectionId: null, status: "expired" };
    let stage: T3CallbackStage = "issuer_validation";
    // Tracked so the failure path can be HONEST: once `saveConnection` has
    // run, a connection row exists and the previous wording ("existing
    // connection remains unchanged") would be false.
    let savedConnectionId: string | null = null;
    // A failed callback emits exactly ONE sanitized diagnostic. A failure can
    // be discovered twice -- the operation that failed, and the attempt
    // bookkeeping that follows it -- and reporting both would misstate the
    // cause, so the reporter guarantees the one-event contract.
    const reporter = createT3CallbackReporter(pending.access);
    try {
      if (args.issuer !== pending.issuer) throw new Error("OAuth callback is invalid");
      if (args.error) {
        // The provider's own answer. A denial and an expiry are the OWNER's
        // decision or the provider's expiry: neither is a failure of Helm and
        // neither is reported as one. `args.code` and `args.error` are mutually
        // exclusive, so this branch is reached before the code check below.
        const outcome = classifyT3ProviderError(args.error);
        // Any failure from here on is a failure to record the attempt, so the
        // stage is the finalisation -- unless the recorder classifies the
        // provider answer itself, which it does for a provider error.
        stage = "attempt_finalization";
        await recordT3ProviderError(
          outcome,
          async (status) => {
            await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status, at: Date.now() });
          },
          (failureStage, error) => { reporter.report(failureStage, error); },
        );
        return { connectionId: null, status: outcome };
      }
      if (!args.code) throw new Error("OAuth callback is invalid");
      stage = "pkce_decryption";
      const verifier = decrypt(pending.verifierCiphertext, `pkce:${owner.issuer}:${owner.subject}:${pending.attemptId}`);
      stage = "token_exchange";
      const response = await json(await safeFetch(pending.tokenEndpoint, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: args.code, redirect_uri: pending.redirectUri,
          client_id: pending.clientId, code_verifier: verifier, resource: pending.resource }).toString(),
      }, assertOwnerCurrent));
      stage = "token_validation";
      const accessToken = requiredString(response.access_token, "access token");
      if (response.token_type !== "Bearer") throw new Error("T3 returned an invalid token type");
      const expiresIn = response.expires_in;
      if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) throw new Error("T3 returned an invalid token lifetime");
      if (expiresIn <= 0 || expiresIn > 31_536_000) throw new Error("T3 returned an invalid token lifetime");
      // The grant must match the consent that was requested: a read-only
      // consent accepts exactly the read scope, an operate consent exactly the
      // operate scope. Anything broader is refused, never stored.
      stage = "scope_validation";
      if (!hasExactT3Scopes(response.scope, pending.access)) {
        throw new Error("T3 granted scopes do not match the requested access");
      }
      stage = "environment_verification";
      const tokenReceivedAt = Date.now();
      const environment = await toolCall(pending.endpoint, accessToken, "t3_environment_read", {}, assertOwnerCurrent);
      const environmentId = requiredString(environment.environmentId, "environment id");
      const environmentLabel = requiredString(environment.label, "environment label");
      const serverVersion = requiredString(environment.serverVersion, "server version");
      const platform = platformLabel(environment.platform);
      stage = "token_encryption";
      const tokenCiphertext = encrypt(accessToken, `token:${owner.issuer}:${owner.subject}:${pending.endpoint}`);
      stage = "connection_save";
      const savedAt = Date.now();
      const connectionId = await ctx.runMutation(internal.t3ConnectionsStore.saveConnection, {
        ...storeOwner(owner), attemptId: pending.attemptId, connectionId: pending.connectionId, endpoint: pending.endpoint, issuer: pending.issuer,
        resource: pending.resource, clientId: pending.clientId, access: pending.access,
        environmentId, environmentLabel, serverVersion, platform, tokenCiphertext,
        expiresAt: tokenReceivedAt + expiresIn * 1000, at: savedAt,
        expectedConnectionCredentialVersion: pending.expectedConnectionCredentialVersion,
      });
      savedConnectionId = connectionId;
      stage = "attempt_finalization";
      await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status: "connected", at: Date.now() });
      return { connectionId, status: "connected" };
    } catch (error) {
      // The reporter emits at most ONE diagnostic for this callback, so a
      // failure that was already reported (for example a provider error whose
      // finalisation also failed) is not reported twice.
      reporter.report(stage, error);
      // The failure-path bookkeeping can itself fail — for example if the
      // owner grant revision changed between the save and the finalisation.
      // That must not replace the sanitized error with a raw one, so it is
      // contained here. The attempt is single-use and expires on its own.
      try {
        await ctx.runMutation(internal.t3ConnectionsStore.finishAttempt, { ...storeOwner(owner), attemptId: pending.attemptId, status: "failed", at: Date.now() });
      } catch {
        // Contained deliberately: the diagnostic above already recorded the
        // true stage, and the external response must stay generic.
      }
      // The wording differs by outcome. A saved connection MUST NOT be
      // described as "unchanged" — the row exists, it is connected, and it may
      // need re-authorization. Saying otherwise would send the owner looking
      // for a change that had already happened.
      const outcome = describeT3CallbackFailure(savedConnectionId !== null);
      throw new Error(outcome.message);
    }
  },
});

const connectionListReturns = v.array(
  v.object({
    connectionId: v.id("t3Connections"), endpoint: v.string(), environmentId: v.string(),
    environmentLabel: v.string(), serverVersion: v.string(), platform: v.string(),
    access: v.union(v.literal("read-only"), v.literal("operate")), status: v.string(), expiresAt: v.number(),
    lastVerifiedAt: v.union(v.number(), v.null()),
    lastSuccessfulReadAt: v.union(v.number(), v.null()),
    lastErrorCode: v.union(v.literal("authorization_required"), v.literal("authorization_expired"), v.literal("endpoint_identity_changed"), v.literal("rate_limited"), v.literal("read_failed"), v.literal("unreachable"), v.literal("model_unavailable"), v.null()),
  }),
);

export const list = action({
  args: {},
  returns: connectionListReturns,
  handler: async (
    ctx,
  ): Promise<Infer<typeof connectionListReturns>> => {
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    return await ctx.runQuery(internal.t3ConnectionsStore.listConnections, { ...storeOwner(owner), now: Date.now() });
  },
});

export const read = action({
  args: { connectionId: v.id("t3Connections"), operation: v.string(), input: v.optional(v.any()) },
  returns: readReturns,
  handler: async (
    ctx,
    args,
  ): Promise<T3ReadResult> => {
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const row = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: args.connectionId, now: Date.now() });
    if (!row) throw new Error("T3 connection is unavailable");
    if (row.status === "expired") throw new Error("T3 connection has expired; reconnect it to continue");
    if (row.status === "reauthorizationRequired") throw new Error("T3 authorization was revoked; reconnect to continue");
    if (row.status === "unreachable") throw new Error("T3 connection is unreachable; refresh it before reading");
    const token = decrypt(row.tokenCiphertext, `token:${owner.issuer}:${owner.subject}:${row.endpoint}`);
    const assertCurrent = async () => {
      const current = await ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, {
        ...storeOwner(owner), connectionId: row.connectionId, credentialVersion: row.credentialVersion,
      });
      if (!current) throw new Error("T3 connection changed while the read was in progress");
    };
    const recordSuccessfulRead = async () => {
      const recorded = await ctx.runMutation(internal.t3ConnectionsStore.recordSuccessfulRead, {
        ...storeOwner(owner), connectionId: row.connectionId, credentialVersion: row.credentialVersion, at: Date.now(),
      });
      if (!recorded) throw new Error("T3 connection changed while the read was in progress");
    };
    const assertBeforeRequest = async () => {
      await assertOwnerCurrent();
      await assertCurrent();
    };
    const markReauthorizationRequired = (errorCode: "authorization_required" | "endpoint_identity_changed" = "authorization_required") => ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
      ...storeOwner(owner), connectionId: row.connectionId, credentialVersion: row.credentialVersion,
      at: Date.now(), status: "reauthorizationRequired", errorCode,
    });
    const readToolCall = async (tool: string, input: Json = {}) => {
      try {
        return await toolCall(row.endpoint, token, tool, input, assertBeforeRequest);
      } catch (error) {
        if (error instanceof Error && /T3 request failed \((401|403)\)/u.test(error.message)) {
          await markReauthorizationRequired();
          throw new Error("T3 authorization was revoked; reconnect to continue");
        }
        throw error;
      }
    };
    const input = (args.input && typeof args.input === "object" ? args.input : {}) as Json;
    const op = args.operation;
    if (!new Set(["environment", "capabilities", "projects", "project", "threads", "thread"]).has(op)) {
      throw new Error("This T3 read operation is not available");
    }
    const environment = await readToolCall("t3_environment_read");
    if (requiredString(environment.environmentId, "environment id") !== row.environmentId) {
      await markReauthorizationRequired("endpoint_identity_changed");
      throw new Error("T3 environment identity changed; reconnect to confirm the endpoint");
    }
    if (op === "environment") {
      await assertCurrent();
      await recordSuccessfulRead();
      return {
        environmentId: row.environmentId, label: nullableString(environment.label),
        serverVersion: nullableString(environment.serverVersion), platform: platformLabel(environment.platform),
        metadata: nullableRecord(environment.preferences),
      };
    }
    if (op === "capabilities") {
      const view = catalogView(await readToolCall("orchestrator_capabilities"));
      await assertCurrent();
      await recordSuccessfulRead();
      return {
      ...view,
      freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false },
      };
    }
    if (op === "project") {
      const projectId = requiredString(input.projectId, "project id");
      const view = projectView(await readToolCall("t3_project_read", { projectId }), row.environmentId, String(row.connectionId));
      if (view.projectId !== projectId) throw new Error("T3 returned a different project than requested");
      await assertCurrent();
      await recordSuccessfulRead();
      return view;
    }
    if (op === "projects") {
      const cursor = input.cursor;
      const limit = input.limit ?? 50;
      if (cursor !== undefined && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("T3 page cursor is invalid");
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("T3 page limit is invalid");
      const nativeArgs: Json = { limit };
      if (cursor !== undefined) nativeArgs.cursor = cursor;
      const result = await readToolCall("t3_project_list", nativeArgs);
      const projects = requiredArray(result.projects, "project page").map((project) => projectView(project, row.environmentId, String(row.connectionId)));
      const nextCursor = nullableCursor(result.nextCursor, "project page cursor");
      await assertCurrent();
      await recordSuccessfulRead();
      return { items: projects, nextCursor, total: nullableCount(result.total, "project count"), freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false } };
    }
    if (op === "threads") {
      const cursor = input.cursor;
      const limit = input.limit ?? 50;
      if (cursor !== undefined && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("T3 page cursor is invalid");
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("T3 page limit is invalid");
      if (input.titleContains !== undefined && (typeof input.titleContains !== "string" || input.titleContains.length > 256)) throw new Error("T3 thread filter is invalid");
      if (input.statuses !== undefined && (!Array.isArray(input.statuses) || input.statuses.length > 10 || input.statuses.some((status) => typeof status !== "string" || status.length > 64))) throw new Error("T3 thread filter is invalid");
      const result = await readToolCall("t3_thread_list", {
        projectId: requiredString(input.projectId, "project id"), cursor, limit,
        titleContains: input.titleContains, statuses: input.statuses,
      });
      const projectId = requiredString(input.projectId, "project id");
      if (requiredString(result.projectId, "thread page project") !== projectId) throw new Error("T3 returned a page from a different project");
      const items = requiredArray(result.threads, "thread page").map((thread) => {
        const view = threadView(thread, row.environmentId, String(row.connectionId), projectId);
        if (view.projectId !== projectId) throw new Error("T3 returned a thread from a different project");
        return view;
      });
      const nextCursor = nullableCursor(result.nextCursor, "thread page cursor");
      const total = result.total;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new Error("T3 returned an invalid thread count");
      await assertCurrent();
      await recordSuccessfulRead();
      return {
        items, nextCursor, total,
        freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false },
      };
    }
    if (op === "thread") {
      const afterPosition = input.afterPosition;
      const limit = input.limit ?? 100;
      if (afterPosition !== undefined && (typeof afterPosition !== "number" || !Number.isSafeInteger(afterPosition) || afterPosition < 0)) throw new Error("T3 thread position is invalid");
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("T3 thread page limit is invalid");
      if (input.itemId !== undefined && (typeof input.itemId !== "string" || input.itemId.length > 256)) throw new Error("T3 thread item is invalid");
      if (input.textOffset !== undefined && (typeof input.textOffset !== "number" || !Number.isSafeInteger(input.textOffset) || input.textOffset < 0)) throw new Error("T3 text offset is invalid");
      const threadViewMode = input.view ?? "activity";
      if (threadViewMode !== "activity" && threadViewMode !== "messages") throw new Error("T3 thread view is invalid");
      const result = await readToolCall("t3_thread_read", {
        threadId: requiredString(input.threadId, "thread id"), afterPosition, view: threadViewMode,
        limit, itemId: input.itemId, textOffset: input.textOffset, maxCharsPerItem: 10_000,
      });
      const detailView = threadDetailView(result, row.environmentId, String(row.connectionId));
      if (detailView.thread.threadId !== input.threadId) throw new Error("T3 returned a different thread than requested");
      await assertCurrent();
      await recordSuccessfulRead();
      return { ...detailView, freshness: { source: "backend", observedAt: new Date().toISOString(), stale: false } };
    }
    throw new Error("This T3 read operation is not available");
  },
});

export const disconnect = action({
  args: { connectionId: v.id("t3Connections") }, returns: v.boolean(),
  handler: async (
    ctx,
    args,
  ): Promise<boolean> => {
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    return await ctx.runMutation(internal.t3ConnectionsStore.disconnect, { ...storeOwner(owner), connectionId: args.connectionId, at: Date.now() });
  },
});

const refreshReturns = v.object({
  environment: v.object({ environmentId: v.string(), label: nullableText, serverVersion: nullableText, platform: nullableText, metadata: v.union(v.record(v.string(), v.any()), v.null()) }),
  observedAt: v.string(),
});

export const refresh = action({
  args: { connectionId: v.id("t3Connections") },
  returns: refreshReturns,
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof refreshReturns>> => {
    const owner = await ctx.runQuery(internal.t3ConnectionsStore.ownerContext, {});
    const assertOwnerCurrent = () => ctx.runQuery(internal.auth.assertCurrentGrant, {
      subject: owner.subject, issuer: owner.issuer, revision: owner.revision,
    });
    const now = Date.now();
    const row = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, { ...storeOwner(owner), connectionId: args.connectionId, now });
    if (!row) throw new Error("T3 connection is unavailable");
    if (row.status === "expired" || row.status === "reauthorizationRequired") {
      const expired = row.status === "expired";
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion, at: now,
        status: expired ? "expired" : "reauthorizationRequired",
        errorCode: expired ? "authorization_expired" : "authorization_required",
      });
      throw new Error(expired ? "T3 connection has expired; reconnect it to continue" : "T3 authorization was revoked; reconnect to continue");
    }
    const token = decrypt(row.tokenCiphertext, `token:${owner.issuer}:${owner.subject}:${row.endpoint}`);
    const assertBeforeRequest = async () => {
      await assertOwnerCurrent();
      const current = await ctx.runQuery(internal.t3ConnectionsStore.getConnectionSecret, {
        ...storeOwner(owner), connectionId: row.connectionId, now: Date.now(),
      });
      if (!current || current.credentialVersion !== row.credentialVersion ||
          current.status === "expired" || current.status === "reauthorizationRequired") {
        throw new Error("T3 connection changed while the refresh was in progress");
      }
    };
    try {
      const environment = await toolCall(row.endpoint, token, "t3_environment_read", {}, assertBeforeRequest);
      if (requiredString(environment.environmentId, "environment id") !== row.environmentId) throw new Error("T3 environment identity changed");
      const at = Date.now();
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, { ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion, at, status: "connected" });
      const current = await ctx.runQuery(internal.t3ConnectionsStore.assertConnectionCurrent, { ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion });
      if (!current) throw new Error("T3 connection changed while the refresh was in progress");
      return {
        environment: {
          environmentId: row.environmentId, label: nullableString(environment.label),
          serverVersion: nullableString(environment.serverVersion), platform: platformLabel(environment.platform),
          metadata: nullableRecord(environment.preferences),
        },
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const unauthorized = /T3 request failed \((401|403)\)/.test(message);
      const identityChanged = /environment identity changed/.test(message);
      const rateLimited = /T3 request failed \(429\)/.test(message);
      const unreachable = /could not be reached|timed out|T3 request failed \(5\d\d\)/i.test(message);
      const status = unauthorized || identityChanged ? "reauthorizationRequired" as const : unreachable ? "unreachable" as const : undefined;
      const errorCode = unauthorized ? "authorization_required" as const : identityChanged ? "endpoint_identity_changed" as const :
        rateLimited ? "rate_limited" as const : unreachable ? "unreachable" as const : "read_failed" as const;
      await ctx.runMutation(internal.t3ConnectionsStore.recordVerification, {
        ...storeOwner(owner), connectionId: args.connectionId, credentialVersion: row.credentialVersion, at: Date.now(),
        ...(status ? { status } : {}),
        errorCode,
      });
      if (rateLimited) throw new Error("T3 request failed (429)");
      if (status === "reauthorizationRequired") throw new Error(unauthorized ? "T3 authorization was revoked; reconnect to continue" : "T3 environment identity changed; reconnect to confirm the endpoint");
      if (status === "unreachable") throw new Error("T3 environment could not be reached");
      throw new Error("T3 environment read failed");
    }
  },
});
