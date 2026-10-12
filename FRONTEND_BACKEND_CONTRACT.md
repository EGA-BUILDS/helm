# Native T3 connection: frontend → backend handoff

This change delivers the owner dashboard UI only. `src/features/t3/contract.ts` is a UI projection and a proposed adapter interface, not an upstream MCP schema or implemented API. No new routes, transport, OAuth actions, token storage, or backend functions exist. There are no dependencies added. Two package scripts select the isolated frontend tests.

## Owner boundary

`OwnerDashboard` still uses the accepted Clerk session, `useConvexAuth`, owner-gated `auth.session` query, and error boundary. Only the verified-owner render body changes. Loading, signed-out, unverified, and non-owner branches remain unchanged. The dashboard does not import Convex or Clerk. Existing account controls and health presentation are passed from the owner component. The existing health query does not prove T3 connectivity.

A future backend adapter must independently authorize every read and mutation against the existing owner contract. Browser UI state, a fixture switch, an endpoint, and a connection ID never authorize access. Do not change Clerk configuration or Convex auth to wire this interface.

## Current behavior and fixture isolation

Without integration, connection state is `not-connected`; all read resources are `unavailable`, not empty successful reads. Local endpoint editing/validation, section navigation, searches over loaded data, detail selection, and copying a T3 reference work. These actions do not contact T3. Endpoint input is held in component state only; no URL query, cookie, browser storage, telemetry, or persistence is used.

Fixture preview requires **both** `NODE_ENV === "development"` and `NEXT_PUBLIC_HELM_T3_FIXTURES === "true"`. Set the latter only in your local shell when starting `pnpm dev`. A visible selector starts **Off**, requiring a second explicit choice. The fixture module is dynamically imported behind the environment gate and checks the same gate again when reading a scenario. Production and test runtimes reject every fixture scenario even when the switch is `true`. There is no production configuration change, public preview route, or owner-guard bypass in the application.

Fixture IDs are prefixed `sample-`, addresses use `.invalid`, and timestamps are unknown. Every active preview has a development banner; connected status is explicitly sample-only. The catalog uses a generic example provider/model and unknown availability. It does not claim any real model exists or can run. Fixtures have no credentials or remote calls.

Scenarios: not connected, OAuth pending, denied, authorization expired, failed, connected, missing environments, empty projects, empty threads, provider unavailable, loading, read error, and stale project data. Changing scenarios resets local searches/selections.

## Endpoint and connection states

The native endpoint is the environment origin plus `/mcp`. The form accepts absolute HTTP/HTTPS URLs (including local/LAN addresses), normalizes a trailing `/mcp/`, and rejects other paths, credentials, query strings, and fragments. This checks syntax only. Network reachability and endpoint security policy are backend responsibilities; a localhost or private address may not be reachable from a hosted Helm backend.

| UI state | Backend interpretation / presentation |
| --- | --- |
| `not-connected` | No approved connection known. No data or authorization implied. |
| `pending` | Approval at T3 is outstanding; `expiresAt` is nullable. Never promote locally to connected. |
| `denied` | T3 consent rejected; no permission acquired. |
| `expired` | An approved sign-in expired; expiry metadata is nullable. An expired approval request can instead return `consent_expired` and begin a new pending flow. |
| `failed` | Sanitized connection/OAuth/transport error; no connectivity inferred. |
| `connected` | Future backend must verify the grant and environment. Includes opaque connection ID, credential-free endpoint, nullable approved access and expiry. The current UI can render this only as a labeled development sample. |

Consent occurs at **T3**, separately from Helm owner sign-in. The owner should approve only a sign-in they started. Approved access can be revoked in **T3 Settings → Connections** and expires after **30 days**. A future adapter must map expiry and revocation immediately to an unavailable authorization state, invalidate resource caches, and require a fresh consent flow. No frontend timer may independently infer successful approval.

| Access | Explanation |
| --- | --- |
| Read only | Project, thread, and provider/model reads; no changes. Default consent choice. |
| Supervised | Thread start/message/stop within the approved runtime and interaction ceilings. |
| Full access | Broader thread start/message/stop permissions within the approved mode limits. |

These descriptions are explanatory, not a local permission selector. The UI cannot grant access. The backend must apply T3’s actual access/mode policy and separately gate mutations. Supervised/full access never removes owner authorization or mode ceilings.

## Proposed adapter boundary

`T3BackendInterface` declares future asynchronous methods. No concrete adapter is supplied and no HTTP route names are proposed. All identifiers are opaque, scoped by connection and environment. Connection/read inputs and operation inputs are separate; future retryable mutations carry `clientRequestId` where supported. `startThread` intentionally has no idempotency promise because upstream launch has no idempotency key; reconcile an ambiguous response before retrying.

- `readConnection`: sanitized connection state; no tokens, secrets, authorization codes, or raw OAuth metadata.
- `readEnvironments`: Helm’s connection inventory enriched by per-environment identity reads. Native `t3_environment_read` reads one server, not an environment-list endpoint.
- `listProjects` / `readProject`: scoped project listing and details, using native cursor pagination and optional metadata.
- `readCatalog`: providers, models, feature object, runtime mode and interaction mode; never a flat `capabilities` list.
- `listThreads`: project-scoped thread page with optional title/status filters.
- `readThread`: detail plus incremental activity/messages, positions and truncation metadata. Dashboard detail maps use the composite `threadDetailKey(connectionId, threadId)` so a repeated upstream thread ID cannot cross connection boundaries.
- `connect` / `reconnect` / `disconnect`: **future-only** lifecycle operations. `connect` and `reconnect` return an opaque `attemptId`, a validated short-lived `authorizationUrl`, and nullable expiry in `OAuthStartResult`. Backend owns OAuth discovery, consent navigation delivery, callback verification, grant storage, revocation and expiry. The frontend may navigate to that returned URL after backend integration; it does not implement a callback route or OAuth server logic. The backend must validate the authorization destination and keep tokens, codes, and callback verification server-side.
- `startThread` / `followUp` / `interrupt`: **future-only** operation inputs and normalized results. Thread launch, message delivery and interruption need distinct native semantics and policy checks.
- `readOperation`: accepted-operation status, once a backend polling contract exists.

`AsyncResponse<T>` is a discriminated union: `completed` includes normalized data and freshness; `accepted` includes an operation ID and nullable polling hint; `failed` includes a sanitized `UiError`. Accepted is not success. Polling, cancellation, retry limits and ambiguous mutation recovery need backend implementation before wiring any button. Native inputs may differ from this projection; decode against the pinned upstream contracts on the server.

## Required native reads

| Helm UI | Native T3 source | Shape / caveat |
| --- | --- | --- |
| Environment cards | `t3_environment_read` | Environment ID, label, version, platform and selected preferences. Nullable/unrecognized fields must stay unknown. |
| Project list | `t3_project_list` | `projects`, numeric `nextCursor` or null; optional numeric cursor and limit 1–100. Pages use the current snapshot and may shift. |
| Project detail | `t3_project_read` | `projectId`; project workspace and metadata. Do not derive a repository identity from the display title. |
| Catalog | `orchestrator_capabilities` | `providers`, `features`, `runtimeMode`, `interactionMode`; nullable inherited provider/model/thread fields. Provider models have IDs, nullable labels and optional option descriptors. |
| Thread list | `t3_thread_list` | `projectId`, optional filters and numeric cursor/limit; `threads`, `nextCursor`, upstream total. Never infer models from the title. |
| Thread detail/activity | `t3_thread_read` | `thread`, `items`, `recentRuns`, `nextPosition`, `hasMore`. Request `view: "activity"`; paginate using `afterPosition`. Truncated text uses `itemId` / `textOffset` and nullable `nextTextOffset` in UTF-16 units. |

Thread reads can have app-owned child-delivery acknowledgment semantics. The backend must evaluate those semantics for an outside-client owner read; do not assume a generic thread-context MCP invocation is side-effect-free.

T3 references use `t3-thread://v1/<threadId>` with the exact returned ID. The UI offers local clipboard copy and selectable text, with an accessible fallback if clipboard access fails. It does not navigate to T3 or launch a thread.

## Nulls, pagination, freshness and errors

`Metadata` is a nullable record of unknown values. Unknown provider options and run metadata remain opaque. Optional/nullable branch, workspace, repository, model, environment version, access and timestamps render as unknown; absence is never converted into availability, a successful check, a zero count or an invented default.

`Page<T>` contains items, nullable numeric `nextCursor`, optional nullable total and freshness. Thread details use their native activity-position shape rather than forcing it into project cursors. Keep terminal null distinct from a valid cursor of `0`. Never use truthiness to decide whether another page exists.

Search is labeled as covering the loaded page only. Current counts describe loaded sample items, not global totals. A future adapter must deduplicate by connection/environment/object ID, handle changing project snapshots, reject invalid cursors explicitly, and replace pages on a fresh query rather than promising a stable snapshot. Pagination controls appear when cursors/positions indicate more data but remain disabled today.

`ReadState<T>` distinguishes unavailable, loading, error and ready. A ready empty page is distinct from a missing integration. Loading uses live status text; sanitized read errors use alerts. `Freshness` includes source, nullable observation time, stale flag and optional snapshot identity. Fixture freshness never masquerades as a live check. Stale data stays labeled and must not authorize mutation. Current read failures omit data; future stale-on-error behavior needs an explicit cache policy.

Error codes cover invalid endpoint, access/consent denial, consent/connection expiry, revocation, unreachable endpoint, unavailable provider, not found, rate limiting, invalid cursor, unavailable backend and unknown failure. Optional request IDs and retry hints must be sanitized. Never render raw backend bodies, stack traces, tokens, codes, client secrets, or request headers. Unknown upstream errors map to a safe message, not a successful empty result.

## Disabled actions and handoff acceptance

Connect/reconnect/disconnect, start thread, send follow-up, interrupt thread, page loading and activity loading are native-disabled buttons with a shared explanation. There is no add-environment or project-registration interface. The message textarea is disabled too. A valid URL or connected sample does not enable any action. There are no event handlers for remote mutations or network reads. Projects and threads are only displayed for a selected connection whose normalized status is `connected`; selecting expired, revoked, or disconnected access does not expose cached lists as current.

Backend handoff must supply a real owner-authorized adapter, transport/grant lifecycle, sanitized validated response decoding, scoped caches, error and pagination behavior, safe consent navigation, and policy-aware operations. After that, replace the unavailable data source and keep fixture isolation; replace the sample-only connected presentation with verified backend state. Enable each operation only after backend acceptance for its exact semantics. Hosted owner auth, actual OAuth grant/denial/revocation/expiry, real model availability, read pagination across shifting snapshots, and live thread operations remain outside this frontend change.

## Validation

- `pnpm test:frontend`: isolated Node/Vitest tests for URL syntax, Clerk owner-gate presentation, connection/read states, unknown metadata, sample labels, pagination controls, disabled operations, multi-environment scoping, navigation structure, local filters and production/test fixture isolation.
- `PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/ms-playwright" pnpm exec playwright install chromium --only-shell`: browser prerequisite contained in the worktree’s ignored dependencies.
- `pnpm test:frontend:browser`: Chromium interaction tests against a test-only Vite harness, using the already installed Vitest/Vite runtime. Tests exercise fixture selection, URL validation, searches, selection, copying, disabled operations, loading/empty/error states, keyboard nav, dark appearance and layouts at 360/768/1440px. The harness explicitly omits owner authentication and is outside Next’s app routes. It is not a hosted auth/OAuth acceptance test.
- `pnpm exec eslint src/features/t3 src/app/OwnerDashboard.tsx src/app/page.tsx tests/frontend playwright.frontend.config.ts vitest.frontend.config.mts`
- `pnpm typecheck`: existing route generation plus TypeScript checks.

The existing Convex test configuration and hosted Clerk/Convex Playwright acceptance configuration are unchanged.

## Pinned source references

UI projection reviewed against `v0.0.46-nightly.20261011.2967`:

- [Outside agents / native endpoint, consent, modes and 30-day approval](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/docs/user/outside-agents.md)
- [MCP OAuth](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/auth/McpOAuth.ts)
- [Project tools](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/mcp/toolkits/project/tools.ts)
- [Environment tools](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/mcp/toolkits/environment/tools.ts)
- [Orchestrator tools](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/mcp/toolkits/orchestrator/tools.ts)
- [Thread tools](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/mcp/toolkits/thread/tools.ts)
- [Orchestrator contract shapes](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/packages/contracts/src/orchestratorMcp.ts)
- [MCP access rules](https://raw.githubusercontent.com/pingdotgg/t3code/v0.0.46-nightly.20261011.2967/apps/server/src/mcp/McpToolAccess.ts)
