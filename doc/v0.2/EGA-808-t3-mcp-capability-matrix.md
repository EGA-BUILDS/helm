# EGA-808 — installed T3 external-MCP capability matrix (v0.2.0-beta.1)

**Status: READ-ONLY INVESTIGATION COMPLETE. No T3 write, OAuth consent, agent launch,
configuration change, or Production action was performed for this document.**

| Item | Value |
| --- | --- |
| Verdict | **PARTIAL** — installed server, external OAuth contract, tool contracts and scopes are verified; the **DEV write target is not approved/configured**, and no authenticated `tools/list` was taken on this build |
| Canonical for | Helm v0.2 beta planning against the installed T3 build below |
| Supersedes for current use | `doc/fixtures/t3-mcp-tools.schemas.json` (0.0.46, 2026-10-09) as a *contract source*; that file stays as historical evidence |
| Related history (unchanged) | [`EGA-758-write-capability-matrix.md`](./EGA-758-write-capability-matrix.md) — live external-OAuth write probe on **0.0.46**; its receipts remain valid for that build only |
| Investigation date | 2026-11-03 |
| Helm source base | `develop` = `90b385287d2c575dee5c054b6ff663f93030427d` |
| Downstream | EGA-809 (Full-access OAuth), EGA-812 (duplicate-proof launch), EGA-813 (workspace strategies), EGA-818 (DEV journey) |

This document is the single canonical capability matrix for the installed build. It does
not rewrite EGA-758's historical receipts; it records what the **currently installed**
server exposes to an **external OAuth MCP client** and what is still unknown.

## 0. Evidence discipline

Every row is labelled:

| Label | Meaning |
| --- | --- |
| **MEASURED** | Read directly from the running server/filesystem in this investigation (read-only). |
| **INSTALLED-SOURCE** | Read from the code embedded in the installed build's own binary. This is the exact shipped implementation, not upstream `main` and not a schema capture. |
| **HELM-SOURCE** | Read from Helm at the base SHA above. |
| **HISTORICAL** | An earlier capture/probe for a different build; never proof for this build. |
| **UNKNOWN** | Not established. Never inferred from a neighbouring fact. |

**Important limitation.** No valid external OAuth credential existed for this investigation,
and obtaining one requires a new owner consent, which this issue is not authorised to
request. Therefore **no authenticated `tools/list` or `tools/call` was made against
0.1.7**. Tool presence and contracts below are read from the installed build's own code;
permission behaviour is read from that same code. Any row that depends on a live
authenticated exchange is marked UNKNOWN, even where the code makes the outcome obvious.

## 1. Installed server and external authorization

### 1.1 What is actually installed

| Fact | Value | Label |
| --- | --- | --- |
| Active runtime version | `0.1.7-nightly.20261103.4119` (`.t3/runtime/current.json` → `activeVersion`; update `committed` from `0.1.7-nightly.20261102.4093`) | MEASURED |
| Binary reports | `t3 v0.1.7-nightly.20261103.4119` | MEASURED |
| Serving process | `t3 serve`, PID 1296848, started `2026-11-03T09:30:07Z`, owning `0.0.0.0:3773` (`ss -ltnp`) | MEASURED |
| Environment id | `99a3aad4-7cb4-4177-9a7e-b445dc19db07` | MEASURED |
| Environment label | `openclaw` | MEASURED |
| Platform | `linux / arm64 / cloud` | MEASURED |
| Orchestration protocol | `2` | MEASURED |
| Database migration | `78` | MEASURED |
| Local MCP endpoint | `http://127.0.0.1:3773/mcp` (`privateNetworkOnly: true`, host `0.0.0.0`) | MEASURED |
| HTTPS MCP endpoint | `https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp` | MEASURED |
| Endpoint identity proof | `GET /.well-known/t3/environment` on that relay returns the **same** `environmentId` and `serverVersion`; `/.well-known/oauth-protected-resource` names `resource = …/mcp` | MEASURED |
| Unauthenticated `/mcp` | `401 {"error":"invalid_mcp_credential"}` (both loopback and relay) | MEASURED |

A second, older `t3 __service-launcher` process from `0.1.1-nightly.20261019.3360` is
present but does **not** own the listening socket. It is not the serving build; the
authoritative observation above is the `0.1.7` `serve` process and the relay identity.

The `prod-` prefix in the relay hostname is a naming convention, not a claim about
Production. Identity is established by the environment id and version returned by the
endpoint itself, not by the hostname.

### 1.2 OAuth surface (measured metadata)

`GET /.well-known/oauth-authorization-server`:

| Field | Value |
| --- | --- |
| issuer | relay origin |
| authorization endpoint | `/oauth/mcp/authorize` |
| token endpoint | `/oauth/mcp/token` |
| dynamic registration | `/oauth/mcp/register` (RFC 7591) |
| response/grant | `code` / `authorization_code` |
| PKCE | `S256` only |
| token endpoint auth | `none` (public client) |
| `scopes_supported` | `orchestration:read`, `orchestration:operate` |
| `authorization_response_iss_parameter_supported` | `true` |

### 1.3 Access levels, scopes, and the Full-access discrepancy

The server's own access model (INSTALLED-SOURCE, `AuthMcpClientAccess` and
`mcpClientScopes`):

| Consent level | Scope set minted into the token | Runtime-mode ceiling for the client |
| --- | --- | --- |
| `read-only` | `orchestration:read` | `approval-required` |
| `approval-required` | `orchestration:read orchestration:operate` | `approval-required` |
| `auto-accept-edits` | `orchestration:read orchestration:operate` | `auto-accept-edits` |
| `auto` | `orchestration:read orchestration:operate` | `auto` |
| **`full-access`** | `orchestration:read orchestration:operate settings:write source-control:write` | `full-access` |

Facts that change how EGA-809 must be built:

1. **The scope string Helm sends does not select the access level.** The authorization
   request is validated for client, redirect URI, `response_type=code`, PKCE, and resource
   — the requested `scope` is not consulted. The token's scope is minted from the level
   the **owner picks on T3's consent page** (`mcpClientScopes(pending.access)`). Helm must
   therefore *instruct* the owner to choose Full access and then *verify* the returned
   set, not "request" full access with a wider scope string.
2. **The protected-resource metadata under-reports Full access.** It advertises only the
   two orchestration scopes even though a Full-access grant also carries `settings:write`
   and `source-control:write`. A client that pre-validates requested scopes against this
   metadata would wrongly conclude Full access is unsupported. The metadata is not the
   grant contract.
3. **Full access changes both the client ceiling and the token.** The external client's
   runtime-mode ceiling becomes `full-access`; interaction mode stays `default`. A
   full-access client can therefore launch threads at `runtimeMode: "full-access"` without
   exceeding its own ceiling.
4. **One-click Full access is conditional.** The consent page offers an access level only
   when the approving browser session already holds every scope of that level plus
   `access:write`/`orchestration:read`. Normal T3 browser sessions are issued the full
   standard scope set, so Full access is normally offered; when it is not, T3 requires a
   pairing code. This is a consent-page property, not a Helm-configurable one.
5. **A managed policy can still cap the mode.** If the T3 deployment carries
   `managedPolicy.limits.maxRuntimeMode`, consent is narrowed to that ceiling. This
   environment reports no managed policy (`server-runtime.json` → `"managedPolicy": null`).

Helm's current callback treats the four-scope Full-access grant as a mismatch
(HELM-SOURCE: `convex/lib/t3OAuthCallbackSafety.ts` — `T3_FULL_ACCESS_SCOPES` is defined
and classified as `operate_mode_full_access`). That refusal is deliberate and is EGA-809's
change to make.

### 1.4 Three permissions that must not be conflated

| Concept | What it controls | Evidence |
| --- | --- | --- |
| **OAuth access level** (this issue's EGA-809 subject) | Which scopes the Helm client holds and the client's runtime-mode ceiling | §1.3 |
| **Thread runtime mode** | What the agent may do inside one thread (`approval-required`, `auto-accept-edits`, `auto`, `full-access`) | `t3_thread_launch.runtimeMode`, `t3_thread_read.thread.runtimeMode` |
| **MCP tool permission** | Whether a given call is refused for this credential (read-only client, missing thread scope, missing capability) | §2.1 |

A Full-access OAuth grant does **not** mean every tool is usable by Helm, and it does not
widen the three-tool write allowlist. It changes the credential's ceiling; Helm's own
allowlist still decides what Helm will dispatch.

### 1.5 External OAuth MCP vs internal provider-agent MCP

The external endpoint serves the **same tool registry** as the in-process agent surface
(`layerTools` merges Preview, Orchestrator, Thread, Attachment, Project, Environment,
Worktree, Pull-request, Device and HTML toolkits onto `/mcp`). The difference is the
credential:

* an **external OAuth client** has `thread: undefined` and capabilities
  `{orchestration, worktree, pull-requests}`;
* an **agent running inside a T3 thread** also carries that thread's identity.

Tools declared `actsAsCaller` / `readsAsCaller` require the caller thread and fail for an
external client with code **`thread_credential_required`**
("… acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP
client signed in from outside a thread."). Tools that only need `reads`/`writes` and take
an explicit `threadId` work for external clients.

Confirmed internal-only for an external OAuth client (INSTALLED-SOURCE handler
declarations): `delegate_task`, `task_status`, `task_cancel`, `create_threads`,
`request_secret`, `t3_background_wait`, all `preview_*` tools, `html_render`,
`t3_worktree_handoff`, `t3_worktree_status`.

This is the distinction the beta spec warns about: presence in the provider-agent surface
is not availability to Helm.

## 2. Native MCP beta operation matrix

Legend: **S** = SUPPORTED by the installed build's external surface (contract read from the
installed code); **U** = UNSUPPORTED; **?** = UNKNOWN. "Live 0.1.7" is the authenticated
call result on *this* build; it is UNKNOWN everywhere because no consent was performed.

### 2.1 Connectivity, identity, catalogue

| # | Operation | Tool | Verdict | Live 0.1.7 | Contract / permission | Limitation or fallback |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Environment discovery, version, connection identity | `t3_environment_read` | **S** | ? | No parameters. Returns `environmentId`, `label`, `serverVersion`, `platform`, `preferences`. `reads`; no thread required; credential must belong to this environment. | If it fails, Helm cannot prove which environment a connection points at and must refuse writes. Unauthenticated `.well-known/t3/environment` also returns identity + capability flags. |
| 2 | Provider/model catalogue, modes, provider limits | `orchestrator_capabilities` | **S** | ? | Optional `environmentId`, `search` (≤200 chars). Returns providers, models, per-model options, `runtimeModes`, `canRunChildTask`, `canRunCrossProviderChildTask`, `constraints`, inherited mode, and a `features` block (`incrementalThreadRead`, `cancellation`, `threadManagement`, `batchThreadCreation`, `maxBatchThreads`). | `models` is a short list; `omittedModels` counts the rest. `search` replaces the short list. Provider authentication failures surface as `constraints`, not as a permission grant. |

### 2.2 Projects and threads

| # | Operation | Tool | Verdict | Live 0.1.7 | Contract / permission | Limitation or fallback |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Project listing with pagination | `t3_project_list` | **S** | ? | `cursor` (≥0), `limit` 1–100; returns `projects[]`, `nextCursor`. `reads`. | "Pages can shift." Re-list rather than caching a cursor across writes. |
| 4 | Project detail | `t3_project_read` | **S** | ? | `projectId`; returns project with workspace and saved scripts. `reads`. | — |
| 5 | Thread listing (incl. T3-originated), status, pagination | `t3_thread_list` | **S** | ? | `projectId` or `allProjects`, `statuses[]`, `titleContains` (≤256), `settled`, `snoozed`, `includeSubagents`, `cursor`, `limit` ≤100. Returns items with `createdBy`, `creationSource`, `status`, `runtimeMode`, `interactionMode`, `linkedPullRequest`, `itemCount`, `nextCursor`, `total`. `reads`. | Project-scoped by default; `allProjects` is required for the cross-project monitor (EGA-811). T3-created threads appear with `createdBy`/`creationSource`; no separate "native thread" flag. |
| 6 | Thread detail + incremental activity | `t3_thread_read` | **S** | ? | `threadId` plus `view: messages\|activity`, `afterPosition`, `limit` 1–100, `runLimit` 1–50, `maxCharsPerItem` 1–50000, and continuation `itemId` + `textOffset`. Returns thread detail (`pendingRequestCount`, `branch`, `worktreePath`, `runCount`, `itemCount`), `recentRuns`, `items[]`, `nextPosition`, `hasMore`. | Marked **not read-only** by the server: reading a child's final result marks it delivered. Cursor units are `position` for items and `nextTextOffset` for a truncated item — they are different cursors. |
| 7 | Queue inspection | `t3_queue` (`action:list\|read`) | **S** | ? | `action` + optional `threadId`, `cursor`, `limit` 1–100. Returns queued entries with `queuedRunId`, truncated text. `reads` for list/read. | Mutating actions (`edit`, `cancel`, `reorder`, `promote_to_steer`) are writes and refused for a read-only client. Not part of the beta contract; available for later UI. |
| 8 | Attention / pending user questions | `t3_pending_request` (`action:list\|read`) | **S** (questions) | ? | `action`, optional `threadId`, `requestId`; returns request ids or question payloads. `reads` for list/read. | **Approvals are not listed** by design ("approvals are not listed"), and `respond` **cannot approve a permission request**. See #9. |
| 9 | Pending **permission approvals** | — | **U** | — | No external-MCP tool lists or answers a permission request. | Helm must show `pendingRequestCount > 0` / a waiting status and a "open in T3" fallback; it must not claim it can approve. This is a real beta gap for "attention" UX. |
| 10 | Thread configuration / current modes | `t3_thread_configure` | **S** | ? | Omit `modelSelection` to read (`threadId` + returned `modelSelection`, `runtimeMode`, `interactionMode`); supplying it writes. `reads` when reading. | The old standalone `t3_thread_configuration` tool no longer exists in this build; reading is the no-argument form of `t3_thread_configure`. |

### 2.3 Launch, send, interrupt

| # | Operation | Tool | Verdict | Live 0.1.7 | Contract / permission | Limitation or fallback |
| --- | --- | --- | --- | --- | --- | --- |
| 11 | Project-based launch | `t3_thread_launch` | **S** | ? | Required: `title`. Optional: `projectId` (**required outside a thread**), `scratch`, `modelSelection{instanceId,model,options}`, `runtimeMode`, `interactionMode`, `workspaceStrategy`, `message` (≤120 000), `attachments` (≤8 pending uploads), `clientRequestId` (≤256). Modes cannot exceed the caller's. Returns `threadId`, `link`, `projectId`, `modelSelection`, `runId`, `status`. `writes` (refused only for read-only clients). | `scratch:true` is exclusive with `projectId`/`workspaceStrategy`. A linked-environment launch cannot carry attachments. Idle launch is allowed by omitting `message`. |
| 12 | Workspace strategies | `t3_thread_launch.workspaceStrategy` | **S** | ? | `worktree` (new checkout from `baseRef`, optional `branch`, `startFromOrigin`), `existing_worktree` (bind `worktreePath` that must already be one of the project's git worktrees), `root` (project checkout, default). Uncommitted edits are not copied. | `existing_worktree` is validated against `git worktree list` and fails with `invalid_request`; fallback is `t3_worktree_list` (external-readable, project-scoped) then `worktree`. `root` is a shared checkout and must not be the default for Helm writes. |
| 13 | Launch idempotency / retry key | `t3_thread_launch.clientRequestId` | **S** | ? | Documented: "Reuse it to retry the same call. A new call gets a new key." The server derives a deterministic command id (`mcp:launch:<sha256([namespace, key])>`) and the **thread id is that command id**, so the same key in the same credential namespace addresses the same thread. | This is the native key EGA-812 should build on. It is *not* a cross-credential guarantee: a reconnect changes the request namespace. Helm still needs its own durable intent record + reconciliation. |
| 14 | Send / follow-up | `t3_thread_send` | **S** | ? | `threadId`, `message` (≤120 000), `mode: auto\|queue\|steer\|restart`, `clientRequestId`. Returns `threadId`, `link`, `messageId`, `runId`, optional `taskId`, `status` (RunStatus), `delivery: started\|queued\|steered\|restarted`. `writesThreads` (also enforces that the target thread's modes do not exceed the caller's). | `delivery` is an acceptance state, not completion. `restart` interrupts and starts a new turn — Helm must not use it for a normal follow-up. `taskId` appears when a send to a finished child thread starts a fresh task. |
| 15 | Interrupt | `t3_thread_interrupt` | **S** | ? | `threadId`, optional `runId` (default: newest running turn), `reason` (≤2 000), `clientRequestId`, and `stop:true` to act like the Stop button (holds queued messages, ends PR watches, stops delegated tasks). Returns `threadId`, `runId`, and `status: interrupt_requested\|no_active_run\|<terminal>`. `writesThreads`. | `interrupt_requested` is an **acknowledgement**, not a confirmed stop. Helm must poll `t3_thread_read`/`t3_thread_wait` for the terminal run status. Idle threads return `no_active_run` — neither an error nor a reason to delete anything. |
| 16 | Wait / completion | `t3_thread_wait` | **S** | ? | `threadId`, optional `runId`, `timeoutMs`, `untilDelegatedWorkSettled`. Returns `status`, `timedOut`, optional `next` / `resultRun`. `reads`. | On timeout the run continues; `timedOut` must be shown as "still running", never as failure. Bound Helm polling; do not hold a request open indefinitely. |

### 2.4 Links and attention state

| # | Operation | Tool | Verdict | Live 0.1.7 | Contract / permission | Limitation or fallback |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | Verified thread reference | `link` field on launch/list/read/send | **S** (code) | ? | Server builds `t3-thread://v2/<environmentId>/<threadId>`; when the client authenticated over HTTP it prefixes the request issuer instead, yielding `<issuer>/threads/<environmentId>/<threadId>`. | The hosted web path was **not** opened in a browser in this issue. Treat the link as a reference, not a proven deep link; fallback = copyable `t3-thread://v2/…` reference + the verified environment origin. |
| 18 | Linked environments (other machines) | `t3_environment_links` | **S** | ? | No parameters; returns this `environmentId`, links with `status: reachable\|unreachable\|expired`, `access`, `expiresAt`, `lastError`, and a `notListed` hint. `reads`. | Requires "Linked environments" enabled on the server; otherwise HTTP 403 `linked_environments_off`. Not needed for the single-VM beta. |
| 19 | Environment link/unlink | `t3_environment_link` / `t3_environment_unlink` | **S** | ? | Link asks the user in a card and returns `pending`; unlink removes a link. `writesEnvironment` → requires **full-access**. | Out of beta scope. Do not build UI for it. |

### 2.5 What is explicitly unsupported or unknown

| Item | Verdict | Why |
| --- | --- | --- |
| Listing or answering **permission approvals** over external MCP | **UNSUPPORTED** | Only user questions are exposed; `t3_pending_request` says approvals are not listed and `respond` cannot approve. |
| A directory of tools the beta spec calls "internal provider-agent" only (`delegate_task`, `task_*`, `create_threads`, `request_secret`, `preview_*`, `html_render`, worktree handoff/status) | **UNSUPPORTED** for external OAuth | They require a calling thread (`thread_credential_required`). |
| Authenticated `tools/list` / any `tools/call` on 0.1.7 | **UNKNOWN** | No external OAuth credential was obtained (read-only boundary). The last live external-OAuth proof is EGA-758 on **0.0.46**. |
| Hosted thread deep link opened in a browser | **UNKNOWN** | Link construction is code-verified; browser behaviour was not tested. |
| Provider-specific mode caps / managed-policy caps | **UNKNOWN** | No catalogue read with a credential; `server-runtime.json` reports `managedPolicy: null`. |
| Interrupt confirmed as terminal within the call | **UNKNOWN** | Contract returns an acknowledgement; EGA-758 observed a terminal transition on 0.0.46 only. |

## 3. Version drift: the checked-in fixture is not this build

`doc/fixtures/t3-mcp-tools.schemas.json` was captured 2026-10-09 from
**`0.0.46-nightly.20261009.2873`** with a read-only token, and lists 80 tools. The installed
build is **`0.1.7-nightly.20261103.4119`**. They are not interchangeable:

* every thread/project/environment tool gained `environmentId` for linked environments;
* action tools were consolidated: `t3_queue_*` → `t3_queue{action}`,
  `t3_pending_request_*` → `t3_pending_request{action}`, the individual
  `preview_click/press/type/hover/select/drag/upload/scroll` → `preview_act{action}`,
  `t3_thread_fork/merge_back/transfers` → `t3_thread_transfer{action}`,
  `t3_thread_configuration` → the read form of `t3_thread_configure`,
  `update_scheduled_task` → `schedule_task` with `scheduledTaskId`;
* new tools include `t3_environment_links`, `t3_environment_link`,
  `t3_environment_unlink`, `t3_background_wait`, `t3_workflow_stop`,
  `t3_thread_transfer`, `read_pull_request_guide`, `write_pull_request_guides`,
  `link_pull_requests`, `unlink_pull_requests`, `preview_act`;
* `t3_thread_interrupt` gained `stop`, `t3_thread_wait` gained
  `untilDelegatedWorkSettled`, and `t3_thread_read` document-points
  `view`/`afterPosition`/`itemId`+`textOffset` explicitly.

The binary contains at least **71 explicit tool definitions** plus separately registered
image/screenshot tools, and the presentation table carries **94 labels** because action
aliases are labelled individually. A raw count is therefore not a contract; only the named
operations above are asserted.

**Consequence:** re-read the contract from the installed endpoint when it changes. Do not
copy limits from this document into a future build without re-checking.

## 4. Safe DEV write target — verdict: NOT VERIFIED

### 4.1 The gate Helm actually enforces

HELM-SOURCE (`convex/lib/writeTargetPolicy.ts`): every native write requires both

```text
T3_NATIVE_WRITE_ENDPOINT      exact MCP endpoint approved for writes
T3_NATIVE_WRITE_ENVIRONMENTS  comma-separated T3 environment ids approved for writes
```

and the stored `operate` grant's endpoint/environment must match exactly. Missing or
malformed configuration refuses with `endpoint_not_configured` /
`environments_not_configured` / `endpoint_malformed` / `environments_malformed` before any
network call. Endpoint policy (`convex/lib/t3EndpointPolicy.ts`) accepts HTTPS only, no
userinfo/query/fragment/port, host `t3coderelay.com` or a subdomain, and exactly `/mcp`.

### 4.2 Observed DEV state (2026-11-03)

| Check | Result | Label |
| --- | --- | --- |
| `T3_NATIVE_WRITE_ENDPOINT` present on DEV Convex | **No** | MEASURED (`npx convex env list --names-only`; names only, no values) |
| `T3_NATIVE_WRITE_ENVIRONMENTS` present on DEV Convex | **No** | MEASURED |
| `T3_MCP_URL`, `T3_MCP_TOKEN`, `T3_MCP_URL_ISOLATED`, `T3_MCP_TOKEN_ISOLATED`, `T3_OAUTH_ENCRYPTION_KEY_V1` present | **Yes** (names only) | MEASURED |
| Native writes currently possible on DEV | **No** — fail closed by design | HELM-SOURCE + configuration above |
| Disposable T3 instance from the earlier proof (`prod-58f89a9b663cfe77.t3coderelay.com`) | **Gone** — `HTTP 530`, Cloudflare `1033` | MEASURED |
| Any other disposable T3 environment | **None identified** | UNKNOWN |

**Verdict: the owner-approved DEV write target does not exist in configuration, and no
disposable T3 instance currently answers.** The only observed environment
(`99a3aad4-…`, label `openclaw`) is the owner's real VM and must never be the write-test
target. No value of either variable was read, and none is recorded here.

### 4.3 What EGA-818 needs before it can run

Owner action, in order:

1. Provision a **disposable** T3 environment (separate instance/user, its own relay host).
2. Read its environment id with `t3_environment_read` from that instance — not from a UI
   label — and record the exact `…/mcp` endpoint.
3. Set `T3_NATIVE_WRITE_ENDPOINT` and `T3_NATIVE_WRITE_ENVIRONMENTS` on **DEV** Convex.
4. Re-run the integration diagnostics; then perform a **Full-access** consent for that
   environment only.

Proposed disposable fixtures for EGA-818 (to be created only under a separate owner GO —
none was created here):

| Fixture | Proposal | Safety property |
| --- | --- | --- |
| Repository | new empty repo with one commit and no hooks | nothing to lose |
| Remote | local bare repo (`file:///…/ega818-remote.git`) or a throwaway private remote | a permitted `git push` reaches nothing shared |
| Branch / worktree | `ega818-disposable` worktree from `baseRef: main` (or `develop`) | distinct checkout; root checkout untouched |
| Project | registered explicitly in the disposable environment | no mapping to a real Helm project |
| Credentials | none on the disposable user: no SSH keys, no `gh` session, no deployment tokens | a publish attempt cannot reach EGA-BUILDS |
| Cleanup | delete thread, project and environment; confirm the connection inventory returns to its prior state | no residue |

## 5. Downstream impact

| Issue | State after this investigation | Required next step |
| --- | --- | --- |
| **EGA-809** Full-access OAuth | **Contract verified; implementation unblocked** | Add a Full-access tier accepting exactly `orchestration:read orchestration:operate settings:write source-control:write`; keep exact-set comparison; update the guards in `convex/t3WriteCapability.test.ts` that currently assert "exactly two access levels" and "no `source-control:write`"; do not treat `scopes_supported` metadata as exhaustive. |
| **EGA-812** Duplicate-proof launch | **Unblocked for design** | Use `clientRequestId` (≤256) as the native retry key and persist Helm's own intent record; reconcile ambiguous acknowledgements with bounded `t3_thread_list` (project + `titleContains`/time window) before any retry. Same key in the same credential namespace resolves to the same thread; a reconnect changes the namespace. |
| **EGA-813** Workspace strategies | **Unblocked** | `worktree` with explicit `baseRef` is supported; `existing_worktree` must first be listed with `t3_worktree_list`; `root` exists but is shared and should not be the write default. |
| **EGA-811** Cross-project attention | **Partially unblocked** | `t3_thread_list{allProjects}` + `t3_thread_read` give status and activity; pending permission approvals cannot be read or answered over external MCP. Show a wait state + T3 fallback, not an approval UI. |
| **EGA-818** DEV journey | **BLOCKED on §4.3** | Needs a disposable environment and the two write-target variables. |

**Not claimed:** EGA-809 and EGA-812 remain blocked in Linear until EGA-808 is marked Done
by its owner. This document supplies the contract they need; it does not change their
issue state.

## 6. Reproduction

Read-only; no token, no consent, no write.

```sh
# version and identity
cat ~/.t3/runtime/current.json
~/.t3/runtime/versions/<activeVersion>/t3 --version
cat ~/.t3/userdata/server-runtime.json
cat ~/.t3/userdata/environment-id
ss -ltnp | grep 3773

# external metadata (no auth)
curl -s https://<relay-host>/.well-known/t3/environment
curl -s https://<relay-host>/.well-known/oauth-authorization-server
curl -s https://<relay-host>/.well-known/oauth-protected-resource
curl -si https://<relay-host>/mcp        # expect 401 invalid_mcp_credential

# installed tool contracts (shipped code inside the binary)
strings -n 8 ~/.t3/runtime/versions/<activeVersion>/t3 > /tmp/t3.strings
# then read the `src/mcp/toolkits/*` sections, `AuthMcpClientAccess`, `mcpClientScopes`,
# `McpToolAccess`, and `src/mcp/McpHttpServer` (layerTools / layerMcpTransport)
```

## 7. Remaining risks

1. **No authenticated observation on 0.1.7.** Contracts are read from the shipped code;
   a live `tools/list` is still owed once a Full-access consent legitimately exists
   (EGA-809/810). A code read cannot prove runtime registration order or feature-flag
   effects.
2. **Full access is chosen, not requested.** A Helm flow that requests four scopes but
   whose owner picks `operate` will get a two-scope token; Helm must fail closed with a
   clear "choose Full access" message, not silently present it as Full access.
3. **Approvals are opaque.** A thread blocked on a permission prompt is visible only as a
   waiting status/count. Do not describe Helm as able to approve.
4. **The safe target is unconfigured.** Until §4.3 is done, every native write refuses by
   design and EGA-818 cannot run.
5. **Version drift is fast.** Three builds in five weeks; the fixture is already two
   generations old.
