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
