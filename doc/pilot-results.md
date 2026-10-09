# Dedicated-user pilot — installed, measured, tested

**Status: PILOT INSTALLED AND TESTED. EGA-677 criterion 4 remains OPEN.**
No real-remote push, merge or deployment was performed or authorized. Integration
remains manual through the owner's existing T3 session.

Host: `openclaw`, Linux aarch64, systemd 249, cgroup v2, nftables.

---

## 1. What was installed

| Component | Value |
|---|---|
| Service account | `t3agent`, uid **2000**, gid 2000, groups **`t3agent` only** |
| Shell | `/usr/sbin/nologin`; password locked via `passwd -l` |
| Stack location | `/opt/t3agent-stack` — **root-owned, 0755, execute-only for `t3agent`** |
| T3 runtime | `0.0.46-nightly.20261009.2873` (t3 binary + `node_modules/` + `client/` + resource-monitor) |
| Provider binary | `/opt/t3agent-stack/opencode/bin/opencode` — **self-contained ELF, no Node runtime needed** |
| Instance | systemd unit `t3agent-serve.service`, `User=t3agent`, port **3774** (not 3773) |
| State | fresh/empty — **nothing copied** |
| Egress | new nft table `inet t3agent_egress`, **output** hook only |
| Memory | `MemoryHigh=3G`, `MemoryMax=4G`, enforced on the service cgroup |
| Swap | **none created**, per instruction |

**Important correction during install:** `t3 serve` failed at first with
`Cannot find module '@cursor/sdk'` because only the `t3` binary had been copied. The
runtime version directory also requires `node_modules/` (76 MB) and `client/` (52 MB)
alongside it. Both were installed, after which `t3 --version` worked.

## 2. Measured resource usage

| Metric | Measured |
|---|---|
| Isolated instance RSS | `t3 serve` **346 MB**, `opencode serve` **307 MB** + **279 MB**, monitor 2 MB |
| Isolated cgroup `MemoryCurrent` | **496 MB** (of `MemoryHigh` 3 G / `MemoryMax` 4 G) |
| Isolated peak RSS | `opencode` 383 MB, `t3 serve` 354 MB |
| Privileged instance RSS | `t3 serve` 441 MB, `opencode serve` 528 MB, monitor 4 MB |
| Disk — stack | **481 MB** (vs 600–700 MB projected; no Node runtime needed) |
| Disk — isolated state | **2.7 MB** (vs 5.4 GB if state had been copied — **0.05%**) |
| `MemAvailable` | 9055 MB baseline → **8452 MB** now; net cost ≈ **600 MB** |
| `SwapTotal` | **0 kB — unchanged, no swap created** |

The earlier ~1500 MB peak projection was for a mature instance. A fresh instance idles
at roughly **half** that. Disk projection was also pessimistic because `opencode.exe` is
a self-contained binary.

## 3. Isolation evidence

All tests run as `t3agent` unless stated. **34 checks passed, 0 real failures.**

### A. Filesystem — 12/12 pass

| Check | Result |
|---|---|
| No sudo | `User t3agent is not allowed to run sudo on openclaw` |
| No privileged groups | groups = `t3agent` only (no `sudo`/`docker`/`lxd`/`shadow`/`disk`) |
| No docker socket | `/var/run/docker.sock` unreadable (`docker` group has no members) |
| No SSH keys | `id_ed25519`, `id_ed25519_abdelilahmortaki`, `id_ed25519_modernizer`, `gitlab_gymsas_vm`, `authorized_keys` — **all denied** |
| No `gh` token | `.config/gh/hosts.yml` denied |
| No real repos | `ls /home/ubuntu/projects/helm` and `.git/config` denied |
| No privileged T3 state | `userdata`, `settings.json`, `secrets/` all denied |
| Reverse check | `ubuntu` also cannot read `t3agent` state |

### B. Credentials — pass

| Check | Result |
|---|---|
| Distinct identity | ubuntu `99a3aad4-7cb4-4177-9a7e-b445dc19db07` vs t3agent `06cae034-c48a-4238-9726-0f2cdf751aa6` |
| No inherited state | t3agent `statev2.sqlite` = **852 KB / inode 3392013** vs ubuntu 3.86 GB / inode 1840467 — different file, not a copy |
| No credential fields | isolated `settings.json` contains only `binaryPath`; **no key/token/secret/password** |
| Not world-readable | isolated `settings.json` mode **0600** (privileged one is still 0664) |
| No real repo registered | 0 references to `/home/ubuntu/projects` in the isolated state DB |
| No ambient opencode auth | t3agent cannot read ubuntu's `opencode.db` (196 MB, mode 0600) |

### C. Control endpoints — pass, both routes

| Route | Target | Result |
|---|---|---|
| Loopback | `127.0.0.1:3773` (privileged `t3 serve`) | **blocked** |
| Loopback | `127.0.0.1:40465` (privileged `opencode serve`) | **blocked** |
| Loopback | `127.0.0.1:20241/20242/20243` (tunnel + `cloudflared`) | **blocked** |
| Egress | `github.com:22`, `gitlab.com:22` | **blocked** |
| **Public relay** | `https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp` | **reachable but `401 invalid_mcp_credential`** |

**uid-scoping controls (proving the rules are not global):**
`ubuntu → 3773` **allowed**; `ubuntu → github.com:22` **allowed**.

**Preservation checks:** existing nft rules are **structurally identical** after the
change (a raw diff showed only live packet-counter increments in the tailscale `ts-input`
chain, which is normal traffic). Our table is `inet t3agent_egress` — a different family
and name from tailscale's `ip filter`. No flush was performed.

### D. Positive control — pass (this is what makes the denials meaningful)

Run **before** interpreting any denial:

| Control | Result |
|---|---|
| `t3agent` → `file://` bare repo it owns | **push succeeded**, `refs/heads/positive` created |
| `t3agent` → `git://127.0.0.1:9419` (allowed port) | **push succeeded**, `refs/heads/netpositive` created |

So `t3agent` genuinely can clone and push when it has a target and a permitted port. The
denials above are therefore properties of the boundary, not of a broken harness.

### E. Model access — pass

```
$ sudo -u t3agent opencode run --model opencode/step-5-preview-free "Reply with exactly: MODEL_OK"
> build · step-5-preview-free
MODEL_OK
```

Real model response, **as `t3agent`**, with **no shared credential** — the free model
resolved without any `opencode auth login`. Provider registered on the isolated instance
as `opencode_2` → `/opt/t3agent-stack/opencode/bin/opencode`. No other provider was
configured, and the privileged instance's provider list is unchanged.

### F. No interference

| Check | Result |
|---|---|
| Privileged `t3 serve` | still listening on 3773, pid 1315586, **uptime 4h21m continuous** |
| Helm repo | `main` @ `a08da09`, **clean**, origin `git@github.com:EGA-BUILDS/helm.git` |
| GitHub refs | `refs/heads/main` only — **nothing pushed** |
| Memory | no OOM, no swap pressure |

## 4. Rollback readiness

`/usr/local/sbin/t3agent-pilot-rollback` (root-owned, 0755, syntax-checked). Verified
that every destructive line targets only pilot artifacts:

```
nft delete table inet t3agent_egress
rm -f /etc/systemd/system/t3agent-serve.service /etc/systemd/system/t3agent.slice
userdel -r t3agent
rm -rf /opt/t3agent-stack
```

`/home/ubuntu` appears **only in read-only verification lines** — never as a delete
target. Estimated full reversal: under a minute. Swap: nothing to undo.

## 5. Incidents and corrections during the pilot

1. **`t3 serve` auto-bootstrapped a project from the cwd.** Launched from inside the Helm
   repo it tried `mkdir /home/ubuntu/projects/helm` and died on `EACCES`. This was my
   launch error, not an isolation break — the fresh state dir was empty. **Runbook rule:
   always start the isolated instance from a neutral cwd**, or it registers whatever repo
   the operator happens to be standing in.
2. **Missing runtime pieces.** `t3` needs `node_modules/` and `client/` beside the
   binary; copying only the binary fails with `Cannot find module '@cursor/sdk'`.
3. **SSH positive control was impossible, twice over.** `passwd -l` locks the account and
   sshd refuses locked accounts ("account is locked"), and `nologin` blocks the command
   channel git-over-ssh needs. Rebuilt the control on `file://` and `git://9419`.
   Side effect: **`t3agent` cannot use SSH-based git at all** — more isolation than planned.
4. **My own test-harness bug.** A `chk` helper treated exit 0 as failure, producing four
   false "FAIL" lines (including one claiming the two environment-ids were identical when
   they were visibly different). Rewrote with explicit `expect_ok`/`expect_fail`. No
   isolation conclusion rests on the buggy version.
5. **`timeout` sent only SIGTERM** and bash `/dev/tcp` connect ignored it, hanging the
   suite. Used `timeout -s KILL`. nft `drop` is silent by design — there is no
   connection-refused oracle, which is correct but means negative tests must be
   timeout-bounded.
6. **`pkill -f 'sshd_config_t3probe'` killed my own shell**, because the pattern matched
   the invoking command line. Switched to PID-based termination.

## 6. What these controls actually prove — and what they do not

**Proven by test:**
- `t3agent` cannot read `ubuntu`'s SSH keys, `gh` token, real repositories, or the
  privileged T3 instance's state and secrets.
- `t3agent` cannot reach the privileged instance's loopback control endpoints or the
  tunnel ports.
- `t3agent` cannot make outbound SSH connections to any host.
- The two instances have distinct identities and share no credentials.
- The isolated instance can run a model, so isolation does not break model access.
- `ubuntu`'s instance, data, egress and Tailscale rules are unaffected.

**NOT proven, and criterion 4 stays open for exactly these reasons:**

- **`github.com:443` is still reachable.** An HTTPS push is blocked only by the absence
  of credentials, not by the network. This was a documented, accepted limitation — but
  it means the boundary is *credential-based for HTTPS*, and no test here attempted a
  real-remote push, so that half remains **untested by design**.
- **The OpenCode permission layer is still agent-side, with no OS sandbox.** The pilot
  does not change that. `bash` remains in `OPENCODE_RESTRICTED_PERMISSIONS` and an
  approval was still never raised in the earlier proof. Isolation contains the blast
  radius; it does not stop an agent from *attempting* a push.
- **Prompt injection is unaddressed.**
- **The isolated relay has no MCP credential yet.** It returned 401 as designed, but no
  owner OAuth approval has been performed for it, so no agent thread has been launched
  through the isolated instance's MCP surface.
- **`t3agent` could still authenticate to a remote using a credential it obtained
  elsewhere on the host.** No OS-level control prevents this today.
- **Memory is bounded but there is no swap**, so a simultaneous peak in both instances is
  an OOM risk rather than a slowdown. Currently ~600 MB net cost with 8.4 GB available.

**Integration remains manual.** No credential-based executor design exists — the
`source-control:write` approach was removed as invalid. The owner performs any real push
in their existing session.

## 7. Next decision

Criterion 4 should be reviewed against the distinction this pilot exposes: **isolation
by absence of credentials and reachability** (now largely demonstrated) versus
**enforcement by the runtime's permission system** (still absent, and unfixable from
Helm's side). The former contains damage; the latter would prevent intent. They are not
the same control and the gate should not treat a passing pilot as proof of the second.