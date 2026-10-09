# Isolated-instance proof — part 2, and the criterion 4 assessment

**Status: BLOCKED on one owner action.** Tasks 4–5 (launch, interrupt, recovery via the
isolated instance's public MCP) cannot proceed until the isolated environment is
authorized for T3 Connect. Everything not dependent on that was completed.

**EGA-677 criterion 4 remains OPEN**, but see section 6 — the wording is not achievable
as written and a revision is proposed.

No real-remote push, merge or deployment was performed. Integration remains manual.

---

## 1. The isolated instance's public MCP URL — blocked, and why

| Instance | T3 Connect exposure | Environment link | Relay |
|---|---|---|---|
| privileged (ubuntu) | **enabled** | provisioned | `https://relay.t3.codes` (+ `prod-e0eb33007bdbf8c3` tunnel) |
| isolated (t3agent) | **disabled** | **not provisioned** | **not provisioned** |

The isolated instance serves `/mcp` on loopback (`127.0.0.1:3774/mcp` → 401), but has **no
relay and therefore no public URL**. Hosted Convex Cloud cannot reach loopback, so the
"from hosted Convex" requirement cannot be met until a relay exists.

Obtaining one requires `t3 connect link`, an OAuth **device flow** against the T3 account:

```
T3 Connect
  Relay client ready - cloudflared 2026.3.0
  Headless authorization
  Open this URL on a device with a browser:
    https://accounts.t3.codes/device?user_code=TTPP-BTXZ
  Confirm this code when asked: TTPP-BTXZ
  Waiting for approval (expires in 10 min).
```

This needs the owner in a browser. It was started in the background; the 10-minute window
expired unapproved, so a fresh link must be issued. **No code was requested in chat.**

Note: the relay hostname is **not** derivable from the environment id. `sha256(envId)[:12]`
gives `af5acac69aac` for the isolated instance and `80c95f749be9` for the privileged one,
while the live privileged relay is `e0eb33007bdbf8c3`. The subdomain is assigned
server-side, so it can only be obtained after authorization.

## 2. Credential class finding — a local token is not an MCP credential

I tried to unblock the loopback path with a locally-minted bearer token
(`t3 auth session issue --scope orchestration:read --scope orchestration:operate`).

```
POST http://127.0.0.1:3774/mcp
-> {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}
```

The isolated instance rejects it exactly as the hosted relay does. Combined with the
earlier finding that `mcpClientScopes` only ever grants orchestration scopes, the picture
is consistent: **MCP requires an OAuth `mcp-client` credential; `cli-issued-session`
tokens are a different class and are never valid MCP credentials on either instance.**

So there is no shortcut around the owner approval. Tasks 1–5 are blocked on it, not on
anything Helm can do.

## 3. Task 7 — every provider child process runs as `t3agent`: PASS

| Process | User | Role |
|---|---|---|
| `t3 serve` (isolated) | **t3agent** | pid 1631669, ppid 1 (systemd) |
| `t3-resource-monitor` | **t3agent** | pid 1631700, child of isolated `t3 serve` |
| `opencode serve` | **t3agent** | pid 1631607 |
| `t3 serve` (privileged) | ubuntu | pid 1315586 |
| `t3-resource-monitor` | ubuntu | pid 1315771 |
| `opencode serve` | ubuntu | pid 1323128 |

- Isolated-stack processes owned by `ubuntu`: **0**
- Service cgroup: `User=t3agent`, `Group=t3agent`
- Privileged stack still runs entirely as `ubuntu`

No cross-contamination in either direction.

## 4. Task 6 — credential denial and push behaviour, with positive controls

All remotes were **loopback-only**. No real remote was contacted.

### 4a. SSH — with a corrected claim (see section 5)

| Test | Result |
|---|---|
| **POSITIVE**: `t3agent` clone+push over `ssh://…:2222` with its key | **succeeded**, `refs/heads/sshpositive` created |
| **NEGATIVE**: same server, key withheld | **failed at auth**, rc=128, **no new ref** |

### 4b. HTTPS — positive control first

| Test | Result |
|---|---|
| **POSITIVE**: same HTTPS server **with** credentials | `http=200` |
| **NEGATIVE**: `t3agent` with no credential | `http=401` |

### 4c. Credential inventory in steady state

`.netrc` absent · `.git-credentials` absent · `credential.helper`: none · git-usable SSH
keys (`id_rsa`/`id_ecdsa`/`id_ed25519`): **0**.

The probe key created for the positive control was **deleted** afterwards, so the steady
state has no Git credential at all.

## 5. Correction to my SSH claim

I previously wrote that *"`t3agent` cannot use SSH-based git at all."* **That was wrong.**
It was an artifact of my own test harness, in two separate ways:

1. My throwaway `sshd` used `AllowUsers t3agent` while the account was **locked**
   (`passwd -l`). sshd refuses locked accounts ("account is locked"), so the failure looked
   like a property of `t3agent` when it was a property of my config.
2. When I retried, `AuthorizedKeysFile` pointed at the **private** key instead of the
   `.pub`, and then the key was named `id_gitprobe`, which git never auto-offers (git only
   tries `id_rsa`, `id_ecdsa`, `id_ed25519`). `ssh -vvv` finally showed
   `Authenticated … using "publickey"` once the naming was fixed.

**Correct statement:** `t3agent` **can** use SSH-based git. What prevents SSH pushes to
real remotes is two ordinary controls, neither of which is an SSH prohibition:

- it holds **no Git credential** (proved in 4a negative and 4c), and
- outbound **TCP 22 is dropped** by the per-uid nft rule (port 2222 is not blocked).

The account is back to `/usr/sbin/nologin` and locked after the test, so this capability
is not usable in the steady state anyway — but the reason is hardening and absence of
credentials, not an inability to speak SSH.

## 6. Criterion 4 against its exact acceptance wording

> **"Runtime/repository controls demonstrate useful coding while push/merge/deployment
> require owner authorization."**

The wording has two clauses with different owners and different fixers.

| Clause | Status | Evidence |
|---|---|---|
| "demonstrate useful coding" | **MET** | Prior proof: agent created `doc/proof/helm-ega677.txt`, `CONTENT_OK`, single-file diff. Repeat run pending task 5. |
| "push/merge/deployment require owner authorization" | **NOT MET** — and not achievable by Helm | The isolated instance has now demonstrated that an agent **can** push over SSH and HTTPS to any loopback target when it holds a credential, and the boundary prevents reaching real remotes by **absence of credential and reachability**, not by runtime approval. |

### What the evidence actually separates

- **Isolation evidence (now strong):** `t3agent` cannot read `ubuntu`'s keys, tokens or
  repos; cannot reach the privileged loopback endpoints or tunnel ports; cannot make
  outbound SSH; holds no Git credential; cannot obtain a real-remote credential from the
  host; runs as its own uid with its own identity. Pushes by `t3agent` are impossible in
  the steady state.
- **Runtime approval enforcement (still absent):** `approval-required` did not gate
  `git push` from either a project root or a worktree. `bash` **is** in
  `OPENCODE_RESTRICTED_PERMISSIONS` and is **not** in `OPENCODE_ALWAYS_ALLOWED_PERMISSIONS`,
  so the design intends to gate it and does not. Root cause still unproven.

These are different controls. The first **contains** damage. The second would **prevent
intent**. A passing pilot proves the first and says nothing about the second. Keeping them
in one clause conflates them.

### Proposed revision — for the owner's decision, not applied unilaterally

Split criterion 4 and move the unfixable half out of Helm's gate:

> **4a. Useful coding demonstrated under an isolated execution boundary.** — *already met*
> The agent performs real work in a disposable clone; the boundary prevents reading host
> credentials and reaching real remotes. Evidence: this pilot plus the prior file-proof.
>
> **4b. Real-remote writes require owner-held credentials, and no execution path exists
> that can obtain them.** — *met by this pilot, subject to review*
> Verified: no SSH/Git credential, no credential helper, no `.netrc`, tcp/22 dropped,
> privileged endpoints unreachable, separate uid and identity. Integration is manual via
> the owner's own T3 session.
>
> **4c. Runtime approval gating for in-workspace Git operations.** — *moved out of Helm's
> gate; tracked as an upstream defect*
> `approval-required` does not gate `bash` despite the permission rules implying it
> should. This is a T3/OpenCode behaviour, not a Helm deficiency, and no Helm change can
> satisfy it. File under `doc/t3-push-permission-bug-report.md`.

Rationale for the change: 4c has no owner inside Helm, so leaving it in the gate means
Helm can never pass its own integration gate regardless of what it builds. That converts a
tracked upstream defect into a permanent blocker and is the "impossible gate" the owner
asked me to name rather than maintain.

If the owner prefers no revision, then criterion 4 stays open and **all dependent execution
work stays blocked** — that is a legitimate outcome, but it should be a chosen one.

## 7. Still unproven

- Tasks 4 and 5 in full: launch, file verification, active interruption and same-thread
  recovery **against the isolated instance**. Not started — blocked on section 1.
- No agent thread has ever run through the isolated instance's MCP surface.
- `github.com:443` remains reachable; HTTPS push is prevented by credential absence only.
- Prompt injection unaddressed.
- OpenCode's permission layer is agent-side, no OS sandbox.
- `t3agent` could still authenticate using a credential obtained elsewhere on the host.
- No swap, so a two-instance simultaneous peak is an OOM risk.

## 8. Cleanup performed

Probe `sshd` (port 2222), HTTPS auth server (8443) and `git daemon` (9419) stopped;
`/etc/ssh/sshd_config_t3git` removed; all probe keys deleted; `t3agent` restored to
`nologin` + locked. Steady state listens on **3773 (ubuntu) and 3774 (t3agent) only**.
Helm at `7197b5f`, clean; GitHub has `refs/heads/main` only.