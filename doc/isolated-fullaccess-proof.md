# Isolated-instance full-access proof — results

All steps run from **hosted Convex** against the **isolated** instance
(`prod-58f89a9b663cfe77.t3coderelay.com`), using `T3_MCP_URL_ISOLATED` /
`T3_MCP_TOKEN_ISOLATED` exclusively.

**No real-remote push, merge or deployment.** The disposable workspace's only remote is
a local bare repo on the same host.

**EGA-677 criterion 4 remains pending review.**

---

## 1. Authorization and credential separation

| Check | Result |
|---|---|
| Token exchange | `200`, at 07:27:30Z, automatic within the code window |
| Granted scope | **`orchestration:read orchestration:operate`** |
| `orchestration:read` | present |
| `orchestration:operate` | present |
| Issuer | isolated relay |
| Storage | `T3_MCP_TOKEN_ISOLATED` + `T3_MCP_URL_ISOLATED` — **new variables** |
| Privileged `T3_MCP_URL` | unchanged: `prod-e0eb33007bdbf8c3` |
| Privileged `T3_MCP_TOKEN` | untouched |

Token hygiene: **279** token occurrences scrubbed from the isolated instance's trace logs
this pass (plus 220 in the earlier pass). Verified: **no JWT anywhere under
`/home/t3agent`**. The pairing grant is consumed — `auth pairing list` reports
"No active pairing credentials". Temporary OAuth/pairing state removed: the
`t3agent` oauth directory, the pairing raw JSON and code, and the local session token
files. The isolated token exists only in Convex secret storage plus the `0600`
owner-side store retained for revocation.

## 2. Launch

| Field | Value |
|---|---|
| Thread | `mcp:d900f37d-e549-4af8-9db0-538e490314e9` |
| Project | `mcp:e165dab7-ec5c-4085-8692-8daf2c39c12f` (`/home/t3agent/worktrees/ega677b`) |
| Model | `opencode_2` / `opencode/step-5-preview-free` |
| Workspace | `workspaceStrategy: {type:"root"}` |

## 3. Effective runtime configuration — verified, not assumed

```
threadId       : mcp:d900f37d-e549-4af8-9db0-538e490314e9
instanceId     : opencode_2
model          : opencode/step-5-preview-free
runtimeMode    : full-access
interactionMode: default
```

Requested and effective values match.

**What `full-access` means for this evidence.** It maps to
`implicitFullAccess` in `openCodePermissionRules`, yielding `{permission:"*", action:"allow"}` —
no approval prompts at all. That is correct and intended *inside* the isolated instance,
but it means this run demonstrates **useful coding under isolation**, and demonstrates
**nothing** about runtime approval gating. Criterion 4's open question is untouched by
this proof.

## 4. Interruption of an active run

`interrupt_requested` returned while the run was `running`; it then reached terminal:

```
status      : interrupted | settled: False
activeRunId : None
runCount    : 1
ord1: interrupted  completedAt=2026-10-10T07:30:15.652Z
```

## 5. Same-thread recovery

`t3_thread_send` on the **same** thread produced run **ordinal 2** — a resume, not a
relaunch:

```
status   : completed
runCount : 2
ord1: interrupted   model=opencode/step-5-preview-free
ord2: completed     model=opencode/step-5-preview-free
```

## 6. No duplicate launch

Title query returned **exactly one** thread (`threads matching title: 1`), with
`runCount: 2` from interruption and resume only. No second launch was created.

## 7. Independent file verification

Verified from the host, **not** from the agent's report:

```
0000000   E   G   A   -   6   7   7       i   s   o   l   a   t   e   d
0000020       f   u   l   l   -   a   c   c   e   s   s       e   x   e
0000040   c   u   t   i   o   n       p   r   o   o   f   .  \n
0000056
46 bytes
```

- Independent Node assertion: **`CONTENT_OK`**, exact match, 46 bytes.
- `git status --porcelain --untracked-files=all`: exactly **1** path →
  **`SINGLE_FILE_DIFF_OK`**.
- No source, lockfile, CI, config or `.env` touched.
- **No commits created** — `git log` still shows only the `seed` commit; the proof file
  is untracked.

## 8. Provider children all run as `t3agent`

| Process | User |
|---|---|
| `t3 serve` (isolated, ppid 1) | **t3agent** |
| `t3-resource-monitor` (child) | **t3agent** |
| `opencode serve` (child, spawned for the run) | **t3agent** |
| Isolated-stack processes owned by `ubuntu` | **0** |

The `ubuntu` processes in the table are the **privileged** stack's own `t3 serve` and
`opencode serve`, which is expected and unchanged.

## 9. Isolation recheck — 12/12 pass

Filesystem: no sudo; no privileged groups (`t3agent` only); no docker socket; no ubuntu
SSH keys; no `gh` token; cannot read the Helm repo or its `.git/config`; cannot read the
privileged T3 `settings.json` or `secrets/`.

Network: `127.0.0.1:3773` and `:40465` blocked; `github.com:22` blocked.
**uid-scoping controls:** `ubuntu → 3773` and `ubuntu → github.com:22` both still
allowed, so the rules remain per-user.

Token hygiene: no JWT in any `t3agent`-readable file.

## 10. No real-remote writes

- Helm `main` at `5e1653a`; GitHub has `refs/heads/main` only.
- Disposable remote holds **only** `refs/heads/main a9b083c` — the seed. Nothing pushed.

---

## What this proves, and what it does not

**Proven:** an agent running as `t3agent` on the isolated instance performs real, useful
coding under `full-access`, in a workspace with no credential and no reachable real
remote; interruption and same-thread recovery work; the file content is byte-exact and
the diff is single-file; and the isolation boundary holds throughout.

**Not proven, and criterion 4 stays pending:**

- `full-access` deliberately removes approval gating, so this run says nothing about
  whether `approval-required` gates Git. The earlier defect — `bash` restricted by
  design yet no approval raised — is unchanged.
- HTTPS real-remote pushes remain prevented only by credential absence, not by network
  control.
- OpenCode's permission layer is still agent-side with no OS sandbox.
- Prompt injection is unaddressed.
- `t3agent` could still authenticate using a credential obtained elsewhere on the host.
- No swap, so a simultaneous two-instance peak remains an OOM risk.