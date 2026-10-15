# Native T3 backend contract (EGA-679)

The handlers require the signed-in Clerk identity and call owner-authorized Convex actions. Convex verifies the owner grant on every operation; state-changing requests also require the configured app origin. The browser receives only projected connection and T3 read data. Environment preferences are returned as opaque metadata, and project status stays null when T3 does not supply it.

## HTTP routes

- `POST /api/t3/oauth/start` accepts `{ endpoint }` for a new connection or `{ connectionId }` for reconnecting the saved endpoint; an optional matching `endpoint` is also accepted on reconnect. It returns `{ attemptId, authorizationUrl, expiresAt }`.
- `GET /api/t3/callback` consumes the single-use OAuth state and redirects to `/` with a coarse `t3` status. It never returns a code or token.
- `GET /api/t3/connections` returns credential-free owner connection records.
- `GET /api/t3/connections/:connectionId/:operation` supports `environment`, `capabilities`, `projects`, `project`, `threads`, and `thread`. Query fields are decoded by the backend.
- `POST /api/t3/connections/:connectionId/refresh` verifies the live environment identity and updates connection health.
- `DELETE /api/t3/connections/:connectionId` disconnects locally and deletes the encrypted access token.

All responses use `no-store`; route errors are sanitized. OAuth and MCP payloads are never logged or returned wholesale. The connection inventory preserves `unreachable` as a distinct backend status so it is not shown as a successful disconnection.

## OAuth and storage

Only trusted HTTPS `*.t3coderelay.com` `/mcp` endpoints are accepted. Each outbound request re-resolves DNS, rejects private/reserved IPv4 targets, pins the selected public IPv4 for TLS hostname verification, limits the body to 1 MiB and times out after 10 seconds. Redirects are not followed. OAuth protected-resource and issuer metadata must identify the exact MCP endpoint and stay on the same trusted origin. The client requests only `orchestration:read`, uses public-client registration and S256 PKCE, and requires the callback issuer and single-use state to match the owner-bound attempt. Tokens have no refresh-token dependency. Only AES-256-GCM ciphertext is persisted; `T3_OAUTH_ENCRYPTION_KEY` is available to Convex Node actions only.

Connection records are scoped to the verified Clerk owner and grant revision. A grant revision change requires reauthorization. Failed reconnects preserve the existing connection. Successful MCP reads update `lastSuccessfulReadAt`; connection projections expose it as `lastReadAt` plus a fixed safe `errorCode` category (`authorization_required`, `authorization_expired`, `endpoint_identity_changed`, `rate_limited`, `read_failed`, or `unreachable`). Raw upstream errors are not persisted. Disconnect clears ciphertext locally; issuer-side revocation remains an owner action in T3 Settings.

## Native tool reads

The allowlist is fixed to `t3_environment_read`, `orchestrator_capabilities`, `t3_project_list`, `t3_project_read`, `t3_thread_list`, and `t3_thread_read`. Mutating tools are not exposed. Project and thread list routes return one native cursor page per request. Clients must follow `nextCursor` until it is null; a non-null cursor is never represented as a complete listing, and the backend does not silently truncate a project inventory. Thread detail requests `view: "activity"` and projects only the fields required by the UI. T3 marks `t3_thread_read` non-readonly because reading an untruncated terminal result from a direct app-owned child can acknowledge delivery. Helm's outside-client transport has no T3 parent-thread context, so it cannot be that direct parent; if the transport ever gains such context, this read must be gated or omitted for those threads.

## Frontend compatibility notes

The frontend contract describes future adapter methods and is not itself a route contract. These routes return credential-free projections shaped around its `ConnectionRecord`, `Environment`, `Project`, `Catalog`, `Thread`, `ThreadDetail`, and `Page` views. Native connection lifecycle has `reauthorizationRequired` and `unreachable`; inventory/detail routes map reauthorization to `revoked` and preserve `unreachable`. The frontend enum needs to add `unreachable` before rendering that state. The connection response also includes `lastReadAt` and a fixed safe `errorCode`; these may be added as optional fields to the frontend `ConnectionRecord` if the UI will display them. The frontend `Project.repositoryIdentity` is a string while T3 returns a structured identity; the projection uses its canonical key. The existing frontend exposes no live adapters or route names; wiring those remains follow-up work. Thread launch, follow-up, interrupt and polling operations remain intentionally unimplemented.

## Connect, Reconnect and Refresh are three different operations

| | Connect | Reconnect | Refresh |
|---|---|---|---|
| Route | `POST /api/t3/oauth/start` `{ endpoint }` | `POST /api/t3/oauth/start` `{ connectionId }` | `POST /api/t3/connections/:id/refresh` |
| Convex action | `t3OAuth.start` | `t3OAuth.start` | `t3OAuth.refresh` |
| Opens a browser consent page | Yes | Yes | No |
| Token | New token via PKCE | New token via PKCE | Reuses the stored ciphertext |
| Storage | Inserts one `t3Connections` row | Patches the SAME row, `credentialVersion + 1` | No credential write |
| Purpose | Create the first grant | Renew or replace a saved grant | Verify health without user interaction |

Only one live connection may exist at a time. A new `Connect` is refused with "A T3 connection already exists; reconnect or disconnect it first" (`start`, `createAttempt`, `saveConnection` all re-check this), so Connect can never duplicate or overwrite the saved grant. Reconnect carries `expectedConnectionCredentialVersion` end to end, and every failure path closes only the attempt — a failed Reconnect leaves the original grant intact and unchanged.

Refresh never launches OAuth. It re-reads `t3_environment_read` with the stored token, confirms the environment identity still matches, and records connection health (`connected`, `reauthorizationRequired`, `unreachable`, plus a fixed `errorCode`). A 401/403 marks the connection as needing reauthorization; it does not delete it.

## Trusted endpoint policy

Both runtimes share one policy in `convex/lib/t3EndpointPolicy.ts`. Only `https` endpoints on `t3coderelay.com` or a subdomain of it, with the exact path `/mcp`, no credentials, no query or fragment, and no explicit port are accepted. T3 Connect provisions one managed environment hostname per linked environment under that domain (for example `prod-<hash>.t3coderelay.com`); the domain apex has no address record and there is no wildcard, so each environment hostname must be treated as an individually provisioned value. Discovery documents are allowed on any path of the same trusted origin.

The browser runs the same check for early feedback, but the backend re-validates every outbound request. The client can never accept a URL the backend refuses, and neither side ever claims a syntactically valid URL is reachable.

## Native T3 pairing codes

Pairing is T3's own approval mechanism and Helm implements none of it. The owner obtains the MCP URL from T3 Settings → Connections, and approves the request either in T3's consent page or with a pairing code minted by `t3 auth pairing create`. Helm must never generate, store, request, log or verify a pairing code: the native OAuth authorization page handles approval, and Helm only ever sees the resulting authorization code through the standard redirect.

## Authorization failures and their user-visible messages

Failures are classified once, in `src/lib/t3Failure.ts`, and mapped onto the frontend `ErrorCode` vocabulary in `src/features/t3/backend.ts`. Upstream text is discarded; only fixed sanitized sentences reach the owner, so no token, PKCE verifier, OAuth state, header or stack trace can leak. Security and configuration refusals are non-retryable; transient transport conditions are retryable.

| Condition | Code | Retryable |
|---|---|---|
| Endpoint not https, not a trusted host, or not `/mcp` | `invalid_endpoint` | No |
| Hostname did not resolve (may be a temporary DNS fault) | `endpoint_unresolved` | Yes |
| TLS/network timeout, 5xx, endpoint down | `unreachable` | Yes |
| Protected-resource or issuer metadata did not match | `discovery_mismatch` | No |
| Consent declined at T3 | `consent_denied` / `access_denied` | No |
| Grant revoked, or the owner revision changed | `revoked` | No |
| Token lifetime elapsed | `connection_expired` | No |
| This deployment's own origin is not configured | `origin_mismatch` | No |
| A required OAuth deployment setting is absent | `misconfigured` | No |

## Required configuration: HELM_APP_URL in two runtimes

`HELM_APP_URL` is required in **both** Next.js/Vercel and Convex DEV. They answer different questions and Connect cannot complete unless they agree.

- **Vercel (Next.js)** — `src/lib/t3Backend.ts` uses it for two things: `requireSameOrigin` compares the request `Origin` header against it on every mutating route (Connect, Reconnect, Refresh, Disconnect), and `helmHomeUrl` builds the post-callback redirect. If it is absent or does not match the served origin, every mutation fails closed as `origin_mismatch` while GET reads keep working — which is exactly the symptom of "the dashboard loads but Connect does nothing".
- **Convex DEV** — `convex/t3OAuth.ts` `callbackUri()` builds the OAuth `redirect_uri` registered with T3 at dynamic client registration. It must be the same origin, or T3 returns the browser to a different deployment than the one that started the attempt.

Operational rules:

1. Set `HELM_APP_URL` for each Vercel environment that needs it. Vercel Preview variables are scoped per branch; a Production-only value leaves Preview builds with none.
2. Redeploy after changing a Vercel variable. It is read at build/run time, not live-updated per request.
3. Convex DEV is shared by every Vercel preview of this project. Changing its value moves the callback origin for **all** previews at once, so only one preview can complete OAuth at a time. Point it at the branch you are actively testing and expect every other preview to fail OAuth until it changes.
4. Per-branch deployment URLs are essentially stable, so a configured Preview origin keeps working across redeploys of the same branch.

Verify presence without printing values:

```sh
npx convex env list --names-only --deployment dev:hardy-warthog-60
npx convex env get HELM_APP_URL --deployment dev:hardy-warthog-60   # config origin, not a secret
```

`requireSameOrigin`, the trusted-host policy and the DNS/IP pinning are security boundaries. Do not disable them, and never derive the trusted OAuth redirect from an unvalidated request `Host` header.
