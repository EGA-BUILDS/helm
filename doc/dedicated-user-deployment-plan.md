# Dedicated-user deployment plan — REVISION 2 (for owner review)

**Status: PLAN ONLY. No infrastructure changes made.** No user created, no service
installed, no firewall rule applied, no file permission altered, no database copied.
T3 remains the executor. Worktrees are never treated as isolation.
**EGA-677 criterion 4 stays OPEN.**

Revision 2 responds to: empty state only, measured overhead, privilege verification,
provider binaries outside ubuntu's home, an honest egress-control evaluation, and an
integration path that grants the isolated agent neither Git credentials nor access to
the privileged instance.

---

## Correction to revision 1

Revision 1 told the isolated instance to reuse an existing runtime path. **That was
wrong and is fixed below.** The real `opencode` binary is:

```
/proc/1323128/exe -> /home/ubuntu/.nvm/versions/node/v24.18.0/lib/node_modules/@opencode/cli/bin/opencode.exe   (196 MB)
```

It lives inside `/home/ubuntu/.nvm/...`, and `/home/ubuntu` is mode 0750. So the
isolated user **cannot read or execute it**. A second instance needs its own Node and
its own `@opencode/cli`, installed outside ubuntu's home. Revision 1 understated the
installation cost by ~300 MB and would have failed at provider start.

---

## 1. Empty state — no copying, no inheritance

The second instance starts with **nothing** carried over. Specifically **not** copied:

| Not copied | Why |
|---|---|
| `statev2.sqlite` (3.6 GB), `state.sqlite` (1.8 GB) | Carries the privileged instance's entire thread/session history. Copying would leak conversation content and defeat isolation. |
| `userdata/secrets/` (0700) | Contains the privileged instance's credentials. |
| `userdata/settings.json` | Contains `serverPassword` and `apiKey` for existing provider instances, and absolute paths into ubuntu's home. |
| `environment-id` | Must be **new**. Reusing it would make the isolated instance impersonate the privileged one at the relay. |
| `~/.config/opencode`, `~/.local/share/opencode` | Provider auth/session state. |
| Any project registration pointing at a real repo | Must be registered fresh, disposable only. |
| `known_hosts`, any `authorized_keys` | Agent-side SSH trust must start empty. |

The only thing reused is the **T3 application version**, installed fresh into the
isolated user's own tree.

## 2. Measured resource overhead

Measured now on the running stack, per instance:

| Resource | Measured | Notes |
|---|---|---|
| RAM, `t3 serve` | **463 MB** RSS | pid 1315586 |
| RAM, `opencode serve` | **523 MB** RSS | pid 1323128 |
| RAM, `t3 __service-launcher` | **236 MB** RSS | pid 1315568 |
| RAM, `t3-resource-monitor` | **4 MB** RSS | pid 1315771 |
| **RAM total per instance** | **~1,224 MB** | 4 processes |
| CPU | `t3 serve` 6.1%, `opencode serve` 3.4% at time of sampling | idle-ish |
| Disk, T3 runtime (one version) | **285 MB** | `0.0.46-nightly.20261009.2873`; t3 binary alone 157 MB |
| Disk, `opencode` binary | **196 MB** | plus a Node runtime |
| Disk, state database | **starts ≈ 0** | see below |

**Estimated fresh-instance cost: ~1.2 GB RAM, ~600–700 MB disk** (285 MB T3 + 196 MB
opencode + ~150 MB Node + near-zero state).

**What I could NOT measure, and am not pretending to:** how large a fresh state database
grows to. The existing 5.4 GB is four days of heavy use across 60+ projects and four
retained nightly versions; an isolated instance holding only disposable clones should
stay far smaller, but that is a guess. A post-install measurement step is included
(V10) and the growth rate should be reviewed after the first week before this is called
cheap.

Disk headroom today: **75 GB free** on `/dev/sda1`. Not a constraint.

## 3. Privilege verification — exact expectations

Precedent exists on this box: `shiploop-engine` (uid 1999, `/nonexistent`,
`/usr/sbin/nologin`) is already a service account.

Facts verified now:

| Check | Current state |
|---|---|
| `/var/run/docker.sock` | Exists, `srw-rw---- root:docker` |
| members of group `docker` | **empty** — nobody, including `ubuntu`, is in it |
| `ubuntu` privileged groups | **`sudo`** and **`lxd`** |
| Existing service-user precedent | `shiploop-engine` |

`lxd` is worth flagging on its own: membership in the `lxd` group is a well-known host
root-escalation path. `ubuntu` has it. `t3agent` must not.

After creation, `t3agent` must satisfy **all** of:

| # | Property | Verified by |
|---|---|---|
| P1 | Not in `sudo` | V1 |
| P2 | Not in `docker`, `lxd`, `shadow`, `disk`, or any group granting privilege | V1 |
| P3 | Cannot open `/var/run/docker.sock` | V2 |
| P4 | Cannot read any of `ubuntu`'s SSH private keys | V3 |
| P5 | Cannot read `ubuntu`'s `gh` token | V4 |
| P6 | Cannot read any real repository | V5 |
| P7 | Cannot read the privileged instance's secrets or state | V6 |
| P8 | Shares no credential with the privileged instance | V7 |
| P9 | **Cannot open a TCP connection to `127.0.0.1:3773`** | V8 + E2 below |
| P10 | Cannot open `127.0.0.1:40465` | V8 + E2 below |
| P11 | `HOME`, `PATH`, `umask` resolve only into its own tree | V9 |

### P9/P10 are a real gap I under-specified in revision 1

**Loopback is not per-user on Linux.** `127.0.0.1:3773` (`t3 serve`, the privileged
control endpoint) and `127.0.0.1:40465` (`opencode serve`) are reachable by *any* local
process regardless of owner. Filesystem isolation does **not** stop this. Revision 1's
claim that a separate user "cannot access the existing T3 control endpoints" was wrong
as stated.

Closing P9/P10 requires the per-uid egress control in section 5 — it is not a filesystem
property and cannot be verified by file permissions alone.

## 4. Provider binaries outside ubuntu's protected home

Installed to a neutral, root-owned location so no user's home is involved:

```
/opt/t3agent-stack/
├── t3/0.0.46-nightly.20261009.2873/t3          # 157 MB binary, root-owned, mode 0755
├── t3/0.0.46-nightly.20261009.2873/resource-monitor/linux-arm64/
├── node/<version>/bin/node                     # Node for the provider
└── opencode/node_modules/@opencode/cli/bin/opencode.exe   # 196 MB
```

- Root-owned, world-readable **execute** only (`0755` on binaries, `0755` on dirs).
- **No world-readable config, credentials, or state** in `/opt/t3agent-stack`.
- `t3agent`'s writable areas are strictly: `/home/t3agent/.t3`,
  `/home/t3agent/.opencode`, `/home/t3agent/remotes`, `/home/t3agent/worktrees`.
- The `t3agent` account is **not** granted write access to `/opt/t3agent-stack`; stack
  updates are a root operation.

Node must be installed independently of `ubuntu`'s nvm tree — a separate install, not a
symlink into it.

## 5. Per-user egress controls — accurate evaluation

### 5a. Root-managed, the agent CANNOT modify — real enforcement

| Mechanism | Available here | Agent can defeat it? |
|---|---|---|
| `nftables` rules matching `meta skuid` | `nft` at `/usr/sbin/nft` | **No.** Requires `CAP_NET_ADMIN`; `t3agent` has none and cannot add itself. |
| systemd `IPAddressAllow=` / `IPAddressDeny=` per unit | systemd **249**, cgroup **v2** present | **No.** Enforced by cgroup eBPF; the unit file is root-owned. |
| network namespace (`PrivateNetwork=yes`) | `unshare` present | **No.** But it removes *all* network, which breaks model access. |

These are **per-user / per-service, not VM-wide.** Existing state confirmed: `ufw` is
**inactive**; there is an active nft `table ip filter` with a tailscale `ts-input` chain
on **input**. The proposed rules go on the **output** hook in a **new, separate table**,
so the tailscale input chain is not touched. No `flush`.

### 5b. Restrictions the agent CAN modify — NOT enforcement

| Mechanism | Why it fails |
|---|---|
| `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` env vars | The agent unsets them. |
| `git config --global http.proxy` | Lives in the agent's own `~/.gitconfig`. |
| `GIT_SSH_COMMAND`, `~/.ssh/config`, `~/.netrc` | All agent-owned. |
| Worktree / repo config | Agent-writable. (Recall: git worktrees *share* remote config with the parent.) |
| DNS-only blocking | Agent can use a raw IP or its own resolver. |

I am explicitly **not** counting any of these as controls.

### 5c. What per-uid egress can and cannot block

**Can block (accurate):**

- **TCP 22 outbound** → all SSH pushes, credential-free. Closes the SSH path entirely.
- **TCP 9418** → `git://` daemon protocol.
- **`127.0.0.1:3773`** → the privileged `t3 serve` control endpoint (satisfies P9).
- **`127.0.0.1:40465`** → the privileged `opencode serve` (satisfies P10).
- Any other loopback port the privileged stack owns.

**Cannot block honestly:**

- **HTTPS pushes to `https://github.com/...`** are not distinguishable by port, since
  443 must stay open for model access. Blocking them needs a domain/IP allowlist, and
  provider/model endpoints sit behind CDNs with changing ranges — that is brittle and I
  will not pretend it is reliable.

So the accurate statement: egress rules **close the SSH path and the loopback
control-endpoint path**. For HTTPS the control remains **credential absence**. Egress
filtering is defence in depth, not the primary control.

## 6. Owner-approved integration path

The isolated agent gets **no Git credential and no route to the privileged instance.**
T3 remains the executor. Two distinct MCP credentials, deliberately different:

| Credential | Scope | Held by | Used for |
|---|---|---|---|
| **Agent** | `orchestration:read` + `orchestration:operate` | Helm (Convex) | Launching/observing threads **on the isolated instance only** |
| **Executor** | `orchestration:read` + **`source-control:write`** — deliberately **no** `orchestration:operate` | Helm (Convex) | The owner-approved Git operation **on the privileged instance** |

Dropping `orchestration:operate` from the executor credential means it **cannot launch
threads on the privileged instance** — so even a compromised Helm dispatch path cannot
start work next to your real repos. It can only do source-control operations.

**Unproven and flagged:** whether `source-control:write` actually gates a push is
**not verified**. I am inferring it from the scope list. If it turns out to be too narrow
or too broad, the executor credential's scope must be re-derived before use.

Flow:

1. Agent (`t3agent`, disposable `file://` clone) writes a change and reports the diff.
2. Helm posts the diff and attempt id to you for review.
3. **You approve** (Linear or the privileged instance's UI).
4. Helm, using the **executor** credential against the **privileged** instance, performs
   the push.
5. Helm records the outcome against the attempt id.

The agent can neither push nor address the privileged instance. You are the only
approver, and the executor credential cannot start threads.

## 7. Exact installation commands (NOT YET RUN)

```bash
# --- 1. Service account: no privileged groups, no shell ---
sudo useradd --create-home --home-dir /home/t3agent \
             --shell /usr/sbin/nologin --user-group t3agent
sudo passwd -l t3agent

# --- 2. Neutral root-owned stack, outside any user's home ---
sudo mkdir -p /opt/t3agent-stack/{t3,node,opencode}
sudo chown -R root:root /opt/t3agent-stack
sudo chmod 755 /opt/t3agent-stack
sudo install -o root -g root -m 0755 <t3-binary> \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3
sudo install -d -o root -g root -m 0755 \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/resource-monitor/linux-arm64
sudo install -o root -g root -m 0755 <resource-monitor-binary> \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/resource-monitor/linux-arm64/
# Node installed independently of ubuntu's nvm tree
sudo install -d -o root -g root -m 0755 /opt/t3agent-stack/node/<ver>/bin
sudo install -o root -g root -m 0755 <node-binary> /opt/t3agent-stack/node/<ver>/bin/node
sudo chown -R root:root /opt/t3agent-stack   # t3agent gets execute, never write

# --- 3. Private writable areas ---
sudo -u t3agent mkdir -p /home/t3agent/{.t3,.opencode,remotes,worktrees}
sudo chmod 700 /home/t3agent /home/t3agent/remotes /home/t3agent/worktrees

# --- 4. Empty state: nothing copied. New environment-id is generated on first run. ---
sudo -u t3agent env HOME=/home/t3agent \
  /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3 serve --port <free-port-not-3773>

# --- 5. Register ONLY disposable projects, never a real repo path ---
sudo -u t3agent env HOME=/home/t3agent \
  /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3 project list

# --- 6. Per-uid egress, ROOT-MANAGED. New table; tailscale input chain untouched. ---
sudo nft add table inet t3agent_egress
sudo nft add chain inet t3agent_egress output '{ type filter hook output priority -10; policy accept; }'
sudo nft add rule inet t3agent_egress output meta skuid 2999 tcp dport 22   drop comment "no SSH pushes"
sudo nft add rule inet t3agent_egress output meta skuid 2999 tcp dport 9418 drop comment "no git daemon"
sudo nft add rule inet t3agent_egress output meta skuid 2999 ip daddr 127.0.0.1 tcp dport 3773  drop comment "no privileged t3 control endpoint"
sudo nft add rule inet t3agent_egress output meta skuid 2999 ip daddr 127.0.0.1 tcp dport 40465 drop comment "no privileged opencode serve"
# 2999 MUST be replaced with t3agent's real uid:  id -u t3agent

# --- 7. Owner approves the NEW relay endpoint and mints the agent credential ---
# --- 8. Narrow executor credential against the PRIVILEGED instance ---
```

## 8. Exact verification commands

Run V1–V11 in order. **V1–V9 must all pass before any agent thread is launched.**

```bash
# V1  no sudo, no privileged groups
sudo -u t3agent sudo -n true            # MUST fail
id -nG t3agent                          # MUST NOT contain sudo|docker|lxd|shadow|disk

# V2  no docker socket
sudo -u t3agent test -r /var/run/docker.sock ; echo "exit=$?"   # MUST be non-zero

# V3  no SSH keys
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519                       # MUST fail
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519_abdelilahmortaki     # MUST fail
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519_modernizer            # MUST fail

# V4  no gh token
sudo -u t3agent cat /home/ubuntu/.config/gh/hosts.yml           # MUST fail

# V5  no real repositories
sudo -u t3agent ls /home/ubuntu/projects/helm                   # MUST fail

# V6  no privileged instance state or secrets
sudo -u t3agent ls /home/ubuntu/.t3/userdata                     # MUST fail
sudo -u t3agent cat /home/ubuntu/.t3/userdata/settings.json      # MUST fail

# V7  no shared credentials: compare the two secrets dirs and environment-ids
sudo -u t3agent ls -la /home/t3agent/.t3/userdata/secrets
cat /home/t3agent/.t3/userdata/environment-id                     # MUST differ from 99a3aad4-…
cat /home/ubuntu/.t3/userdata/environment-id                      # 99a3aad4-7cb4-4177-9a7e-b445dc19db07

# V8  control endpoints actually blocked (loopback is shared, so test the connection)
sudo -u t3agent bash -c 'exec 3<>/dev/tcp/127.0.0.1/3773'  ; echo "3773 exit=$?"   # MUST be non-zero
sudo -u t3agent bash -c 'exec 3<>/dev/tcp/127.0.0.1/40465' ; echo "40465 exit=$?"  # MUST be non-zero

# V9  environment sanity
sudo -u t3agent env | grep -E '^(HOME|PATH)='   # MUST be /home/t3agent and /opt/t3agent-stack only

# V10 measure real overhead after first run (the figure I could not obtain in advance)
ps -eo user,rss,args | grep -E 't3 serve|opencode serve' | grep t3agentStack
du -sh /home/t3agent/.t3

# V11 positive control BEFORE any negative claim
# loopback git server, push WITH a t3agent-owned key -> MUST succeed.
# If this fails, every later "the push was blocked" result is meaningless.
```

## 9. Exact rollback commands

```bash
# 1. stop the isolated stack (distinct from the privileged one)
sudo pkill -u t3agent -f 't3 serve'
sudo pkill -u t3agent -f 'opencode serve'

# 2. remove egress rules (the whole table; tailscale input chain is a different table)
sudo nft delete table inet t3agent_egress
sudo nft list tables          # confirm inet t3agent_egress is gone

# 3. revoke BOTH credentials - do not leave them dangling
#    agent credential:     revoke the session minted for the isolated relay
#    executor credential:  revoke the source-control:write session
# t3 auth session revoke <session-id>

# 4. drop the credential from the Convex deployment and restore the previous value
#    npx convex env set T3_MCP_TOKEN <previous-value>

# 5. remove the account and all state
sudo userdel -r t3agent

# 6. remove the shared stack
sudo rm -rf /opt/t3agent-stack

# 7. confirm the privileged instance is untouched
ss -ltnp | grep 3773                       # still listening, owner ubuntu
ps -o user,pid,args -p 1315586            # still ubuntu
git -C /home/ubuntu/projects/helm status   # clean, origin unchanged
cat /home/ubuntu/.t3/userdata/environment-id
```

Rollback is complete and touches nothing owned by `ubuntu`. The one item needing
deliberate care is **step 3**: a credential nobody remembers revoking outlives its
purpose, which is the failure mode this whole plan exists to avoid.

## 10. Stale artifact from earlier EGA-677 work

```
LISTEN 127.0.0.1:4180   pid 1486727   node helm-proof-callback.mjs   (uptime 1h08m)
```

This is **my own leftover** from the OAuth proof, still holding a loopback port. It is
not part of any plan and should be killed:

```bash
kill 1486727        # or: pkill -f helm-proof-callback.mjs
```

Flagged rather than done, to respect "no infrastructure changes yet."

## 11. Stays open

- **EGA-677 criterion 4 remains OPEN.** Nothing here is implemented or proven.
- **`convex/credentials.ts` and `convex/launchAttempts.ts` remain UNWIRED** — unit-tested
  only, no dispatch path calls them.
- **Changing the environment default `runtimeMode` is NOT a fix.** The demonstrated
  failure is that `bash` is restricted by design yet no approval was raised.
- **State-database growth is UNMEASURED** (V10 measures the starting point; review after
  a week).
- **`source-control:write` gating a push is UNVERIFIED.**
- **HTTPS real-remote pushes remain possible in principle**; only the credential absence
  prevents them. The egress rules close SSH and loopback, not HTTPS.

## Decisions needed

1. **Approve the empty-state second instance?** Costs: a new relay identity needing your
   OAuth approval, ~1.2 GB RAM, ~600–700 MB disk, two nightly-version stacks to update.
   Buys: the only available fix for P1–P11, including the loopback control-endpoint gap.
2. **Approve the nftables per-uid output table?** Per-user, not VM-wide; separate table;
   tailscale's input chain untouched.
3. **Accept the executor credential without `orchestration:operate`?** It is the cleanest
   structural separation, but its push-gating behaviour is unverified.
4. **Fix the 0664 `settings.json` on the existing instance?** Unrelated, cheap, real
   exposure — still not done.