# EGA-677 criterion 4 — revised, with evidence per claim

**Status: criterion 4 remains PENDING REVIEW.** This document splits the original single
clause into three independently-testable claims, because the original wording fused a
control Helm can implement with one it cannot, which made the gate unpassable regardless
of what Helm built.

Original wording:

> Runtime/repository controls demonstrate useful coding while push/merge/deployment
> require owner authorization.

---

## 4a — Useful coding under an isolated execution boundary

**Claim:** an execution agent performs real, useful work inside a boundary that contains
its blast radius.

**Verdict: PROVEN — TESTED.**

| Evidence | Result |
|---|---|
| Agent runs real work | Created `doc/proof/helm-677-isolated.txt` under `full-access` |
| Effective config verified, not assumed | `t3_thread_configuration` → `opencode_2` / `opencode/step-5-preview-free`, `runtimeMode: full-access` |
| Content byte-exact | `od -c`, 46 bytes, independent Node assertion `CONTENT_OK` |
| Single-file diff | `--untracked-files=all` → 1 path; no source/lockfile/CI/config touched |
| No commits, no remote writes | only the `seed` commit exists; GitHub has `refs/heads/main` only |
| Active interruption | terminal `interrupted`, `activeRunId: None` |
| Same-thread recovery | run **ordinal 2** in the same thread; `runCount` 1→2 |
| No duplicate launch | title query returned exactly 1 thread |
| Dispatch wired end to end | see 4c table |

## 4b — Real-remote writes require owner-held credentials

**Claim:** no execution path can reach or write to a real remote without credentials the
agent does not hold; real integration is owner-controlled.

**Verdict: PROVEN — TESTED (with one stated limit).**

Tested on the dedicated `t3agent` instance, 12/12 isolation checks passing:

| Control | Evidence |
|---|---|
| No sudo | `sudo -n true` denied; `sudo -l` → not allowed |
| No privileged groups | groups = `t3agent` only (no `sudo`/`docker`/`lxd`/`shadow`/`disk`) |
| No Docker socket | `/var/run/docker.sock` unreadable; `docker` group has no members |
| No host SSH keys | all four private keys + `authorized_keys` denied |
| No `gh` token | `.config/gh/hosts.yml` denied |
| No real repos | Helm repo and its `.git/config` denied |
| No privileged T3 state | `settings.json`, `secrets/` denied |
| No outbound SSH | `github.com:22`, `gitlab.com:22` blocked |
| No privileged endpoints | `127.0.0.1:3773`, `:40465` blocked |
| Rules are per-user | `ubuntu` still reaches both — controls are not global |
| No Git credential in steady state | 0 git-usable keys, no `.netrc`, no credential helper |
| Provider children | isolated `t3 serve`, `resource-monitor`, `opencode serve` all uid 2000 |

**Positive controls were run before any denial was trusted:** `t3agent` pushed
successfully to a `file://` repo it owns and to `git://127.0.0.1:9419`, and over
`SSH/2222` with its key (`refs/heads/sshpositive` created) — so later denials are
properties of the boundary, not a broken harness.

**Stated limit:** `github.com:443` remains reachable. HTTPS real-remote push is prevented
by **credential absence only**, not by network control, and was not tested because no
real-remote write was authorized.

Owner-controlled integration: no executor credential exists. The `source-control:write`
design was **removed** after proving it is not an MCP OAuth scope. Real pushes are manual,
performed by the owner in their own T3 session.

## 4c — Runtime approval gating for in-workspace Git operations

**Claim:** `runtimeMode: approval-required` gates Git operations such as `push`.

**Verdict: NOT PROVEN — FAILING BY OBSERVATION. UPSTREAM DEFECT, NOT A HELM DEFECT.**

Evidence that it does not hold:

| Workspace | Push outcome |
|---|---|
| project root (`{type:"root"}`) | executed, exit 0, **no approval prompt** |
| isolated worktree | executed, exit 0, **no approval prompt** |

The design *intends* to gate this. From the installed nightly:

```js
OPENCODE_RESTRICTED_PERMISSIONS = ["bash","edit","webfetch","websearch", ...]
OPENCODE_ALWAYS_ALLOWED_PERMISSIONS = ["question","read","glob","grep","lsp", ...]
```

`bash` is restricted and **not** always-allowed, so `approval-required` should mark it
`ask`/`deny`. Re-reading all three proof transcripts found **no approval request at all**.
Root cause remains **unproven**; the leading hypothesis is that the OpenCode session is
created with the environment-default `full-access` rules rather than the per-thread
policy. That needs T3-side instrumentation.

**Why this moves out of Helm's gate:** no Helm change can make the T3/OpenCode permission
layer gate a shell command. It is enforced agent-side with no OS sandbox
("OpenCode does not provide an OS sandbox"), so it binds good-faith behaviour, not a
compromised agent. Leaving it inside Helm's gate means Helm can never pass its own
integration gate no matter what it ships — a tracked upstream defect presented as a Helm
blocker.

### Security finding from the wiring — RESOLVED

`launchAttempts` originally exported **public** mutations, so dispatch had to call
them via `api.*`. Any client reaching the deployment could forge attempts and
acknowledgements. All seven `launchAttempts` exports and both public `credentials`
queries are now `internalMutation`/`internalQuery`, and `dispatch.ts` calls
`internal.*`. Verified against a live unauthenticated HTTP client — see
`doc/dispatch-hardening.md`. Regression-guarded by `convex/authz.test.ts`.

## 4d — Credential lifecycle wired into dispatch

**Claim:** dispatch pauses on auth failure and never auto-relaunches an ambiguous launch.

**Verdict: PROVEN — TESTED through the real dispatch path, including reconciliation.**

`credentials.ts` and `launchAttempts.ts` were previously unwired (unit-tested only).
They are now called by `convex/dispatch.ts`, exercised end to end:

| Step | Observed |
|---|---|
| No credential recorded | `paused` — **before any MCP call**, `attemptId: null` (fail-closed) |
| Credential recorded | `dispatched`, thread id captured, unique key `[helm:EGA-677-D2:iftejrzxya]` |
| Auth failure inside dispatch | `ambiguous`; credential → `reauthorizationRequired`, `invalid_mcp_credential` |
| **Next** dispatch | `paused` with *"owner reauthorization required"*, `attemptId: null` — **no attempt, no launch** |
| Ambiguous attempt | queued for a human; `relaunchAuthorized: false` |
| Owner reauthorization | credential `active`, failures `0`, dispatch resumes |
| **Lost ack (launch really accepted)** | `reconciled` to the thread that exists; **no second launch** |
| **Zero matches** | stays `ambiguous`, `relaunchAuthorized: false` |
| **Many matches** | `ambiguous`, and a later duplicate **demotes** a settled attempt |
| Threads created | one per dispatch; the failed and paused dispatches created **none** |

The reconciliation step is real, not a stub: the correlation key is embedded in the
thread title and searched for on `t3_thread_list`. A lost acknowledgement resolves
only when exactly one thread carries that key.

---

## Summary table

| Claim | Verdict | Basis |
|---|---|---|
| 4a useful coding under isolation | **PROVEN** | byte-exact file, interrupt + same-thread recovery, single-file diff, no duplicate |
| 4b real-remote writes need owner credentials | **PROVEN** (limit: HTTPS prevented by credential absence only) | 12/12 isolation checks with positive controls; manual owner integration |
| 4c runtime approval gating for Git | **FAILING BY OBSERVATION** | two runs, exit 0, no prompt; upstream defect |
| 4d credential lifecycle wired into dispatch | **PROVEN** | pause-on-failure, fail-closed gate, no auto-relaunch, recovery |

## Still not proven

- 4c is unresolved and cannot be resolved from Helm.
- HTTPS real-remote push untested (no write authorized).
- OpenCode permission layer is agent-side, no OS sandbox.
- Prompt injection unaddressed; 4a/4b bound blast radius, they do not prevent intent.
- `t3agent` could still authenticate with a credential obtained elsewhere on the host.
- Credential expiry/renewal: genuine TTL expiry still untested; recovery by
  re-authorization is proven, automatic renewal is not.
- No swap, so a simultaneous two-instance peak is an OOM risk.
- The public `launchAttempts` surface above.