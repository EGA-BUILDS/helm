# Dedicated-user deployment plan — REVISION 3 (final, for owner review)

**Status: PLAN ONLY. Nothing installed.** No user, no stack, no nft table, no
permission changed, no state copied. T3 remains the executor. Worktrees are never
treated as isolation. **EGA-677 criterion 4 stays OPEN.**

Revision 3 resolves the four open uncertainties. **One design was invalid and has been
removed.**

---

## 1. `source-control:write` — NOT an MCP OAuth scope. Design removed.

### Finding

```js
mcpClientScopes = (access) => access === "read-only"
  ? [AuthOrchestrationReadScope]
  : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
```

An MCP OAuth client can **only ever** receive `orchestration:read` and/or
`orchestration:operate`. Nothing else is reachable through the MCP OAuth flow.

`source-control:write` exists, but on a different surface:

| Fact | Evidence |
|---|---|
| It is a valid *session* scope | listed in `AuthStandardClientScopes`; offered by `t3 auth session issue --scope` |
| It is a child of `orchestration:operate` | `[AuthSourceControlWriteScope]: AuthOrchestrationOperateScope` |
| It gates **clientRpc/WebSocket** methods | `CLIENT_GUARDED_RPC_SCOPES` gates `pullRequestsRunAction`, `pullRequestsUpdate`, `pullRequestsComment`, `pullRequestsUpdateComment`, `pullRequestsSubmitReview`, `pullRequestsReplyToThread`, `pullRequestsSetThreadResolution`, and `gitPreparePullRequestThread` |
| It gates **no MCP tool** | no entry in any of the 80 MCP tool schemas |

### The dangerous part

A live probe requesting `scope=orchestration:read source-control:write` returned
**HTTP 302** — accepted, redirected to the approval page. It is **silently ignored,
not rejected**. The grant is resolved at mint time from `mcpClientScopes(access)`, so
the issued token silently carries only the orchestration scopes.

An integrator would reasonably believe they held a narrowly-scoped executor credential
when they held a full `orchestration:operate` token instead. That is worse than a
rejection, and it is why the design is being removed rather than adjusted.

### Replacement: manual integration through the existing owner-controlled T3 session

The `source-control:write` executor credential is **deleted from the design.** No
second credential is created. Instead:

1. Agent (`t3agent`, disposable `file://` clone) writes the change and reports the diff.
2. Helm posts the diff and attempt id to you.
3. **You perform the push yourself**, in your existing owner-controlled T3 session on
   the privileged instance — where you are already authenticated and already hold the
   credentials. T3 remains the executor; the executor is *you*, in your own session.
4. Helm records the outcome against the attempt id.

Trade-off, stated plainly: this is **manual**, so it is slower and it will not scale
past a handful of dispatches. That is acceptable now and is the correct trade while
criterion 4 is unproven — automating an unproven permission path is precisely the
mistake the gate exists to prevent. Revisit only once a scoped, *verified* mechanism
exists.

---

## 2. Isolation must cover the public relay route, not just loopback

### Loopback — blockable per uid

All privileged endpoints are loopback-bound and shareable by any local process:

| Port | Process | Must block for `t3agent` |
|---|---|---|
| 3773 | `t3 serve` (privileged control endpoint) | yes |
| 40465 | `opencode serve` | yes |
| 20241, 20242 | T3 tunnel helpers | yes |
| 20243 | `cloudflared` (exposes the relay) | yes |

nftables `meta skuid` output rules cover all of these. Verified available: `nft` at
`/usr/sbin/nft`.

### Public relay — NOT cleanly blockable, and here is why

```
prod-e0eb33007bdbf8c3.t3coderelay.com  ->  104.26.2.228, 104.26.3.228, 172.67.73.71 (+ IPv6)
```

Those are **Cloudflare shared CDN addresses**. Dropping them would also block a very
large amount of unrelated internet traffic. That collateral is unacceptable, so
**IP-based blocking of the relay is off the table** — I am not proposing it.

nftables matches packets, not TLS SNI, so hostname-based filtering is not available at
that layer. A TLS-terminating proxy could express the hostname but adds operational
weight and is bypassable by any agent controlling its own egress.

**So the public route is covered by a different control: the agent holds no credential
for it.** Reaching the URL without a valid `mcp-client` token yields
`invalid_mcp_credential` — already demonstrated empirically against this exact endpoint
(garbage, revoked, empty-bearer, missing-header and wrong-scheme cases were all
rejected; only the two valid tokens succeeded).

Accurate position:

| Route | Control | Strength |
|---|---|---|
| Loopback 3773 / 40465 / 2024x | per-uid nftables drop | real enforcement |
| Public relay URL | **no credential held** | real, but not network-enforced |
| Any future real remote (HTTPS) | no Git credential held | real, not network-enforced |

A `/etc/hosts` entry blackholing the relay hostname is available and root-managed, but I
am **not** proposing it as a control: the agent can bypass it with a raw IP and a `Host`
header, and the IPs are shared anyway. It would be a speed bump presented as a wall.

---

## 3. Memory — peak and headroom, not disk

Measured now:

| Metric | Value |
|---|---|
| `MemTotal` | **11.7 GB** |
| `MemAvailable` | **9.0 GB** |
| `buff/cache` | 8.8 GB |
| **Swap** | **0 B — none configured, no zram** |

Peak RSS (`VmHWM`, high-water mark) of the existing stack:

| Process | Peak | Current |
|---|---|---|
| `t3 __service-launcher` | 321 MB | 236 MB |
| `t3 serve` | **563 MB** | 463 MB |
| `t3-resource-monitor` | 4 MB | 4 MB |
| `opencode serve` | **612 MB** | 531 MB |
| **Total peak** | **~1,500 MB** | ~1,234 MB |

Peak is **~23% higher** than my revision-2 figure of 1,224 MB, which was current RSS,
not peak. Revision 2's number was the wrong metric.

Projected: second instance **~1,500 MB peak** → both at peak **~2.9 GB** → headroom
**~6.2 GB**.

**Honest limits.** This is a *baseline* from a mature instance, exactly as you said — it
is not a measured fresh-instance cost. A fresh instance may be lower (no session
history) or higher (cold caches, first-run index builds). It cannot be measured without
installing, so V12 measures it post-install and the projection should be treated as an
order-of-magnitude estimate.

**The real risk is not capacity, it is the missing swap.** 9 GB available against ~2.9 GB
projected peak is comfortable *on average*, but with `SwapTotal: 0` there is no buffer —
a simultaneous peak, or one runaway process, results in the OOM killer, not throttling.
Two cheap mitigations, neither applied:

```bash
# Option A: 2 GB swapfile (recommended)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Option B: memory cap on the isolated instance's unit
#   MemoryMax=3G / MemoryHigh=2.5G
```

I recommend **A**. It is host-level and would need your approval; I have not touched it.

---

## 4. Final installation commands (NOT YET RUN)

```bash
# ============ 1. Service account: no privileged groups, no login shell ============
sudo useradd --create-home --home-dir /home/t3agent \
             --shell /usr/sbin/nologin --user-group t3agent
sudo passwd -l t3agent
T3AGENT_UID=$(id -u t3agent)

# ============ 2. Neutral root-owned stack, outside every user's home ============
sudo mkdir -p /opt/t3agent-stack/{t3,node,opencode}
sudo chown -R root:root /opt/t3agent-stack && sudo chmod 755 /opt/t3agent-stack
sudo install -d -o root -g root -m 0755 \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/resource-monitor/linux-arm64
sudo install -o root -g root -m 0755 <t3-binary> \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3
sudo install -o root -g root -m 0755 <resource-monitor> \
     /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/resource-monitor/linux-arm64/
# Node installed independently of ubuntu's nvm tree (NOT a symlink into it)
sudo install -d -o root -g root -m 0755 /opt/t3agent-stack/node/<ver>/bin
sudo install -o root -g root -m 0755 <node-binary> /opt/t3agent-stack/node/<ver>/bin/node
sudo chown -R root:root /opt/t3agent-stack      # t3agent: execute only, never write

# ============ 3. Private writable areas ============
sudo -u t3agent mkdir -p /home/t3agent/{.t3,.opencode,remotes,worktrees}
sudo chmod 700 /home/t3agent /home/t3agent/remotes /home/t3agent/worktrees

# ============ 4. Empty state. Nothing copied. New environment-id generated. ======
#    (specifically NOT: statev2.sqlite, state.sqlite, secrets/, settings.json,
#     environment-id, provider auth dirs, any real-repo project registration)
sudo -u t3agent env HOME=/home/t3agent PATH=/opt/t3agent-stack/node/<ver>/bin:/usr/bin:/bin \
  /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3 serve --port <free-port-not-3773>
sudo -u t3agent chmod 700 /home/t3agent/.t3
sudo -u t3agent chmod 600 /home/t3agent/.t3/userdata/settings.json   # avoid the 0664 issue

# ============ 5. Register ONLY disposable projects ============
sudo -u t3agent env HOME=/home/t3agent \
  /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3 project list

# ============ 6. Per-uid egress. NEW table, OUTPUT hook. Tailscale INPUT untouched.
#                     No flush. NOT VM-wide: only uid $T3AGENT_UID is affected. ======
sudo nft add table inet t3agent_egress
sudo nft add chain inet t3agent_egress output '{ type filter hook output priority -10; policy accept; }'
sudo nft add rule inet t3agent_egress output meta skuid "$T3AGENT_UID" tcp dport 22   drop comment "no SSH pushes"
sudo nft add rule inet t3agent_egress output meta skuid "$T3AGENT_UID" tcp dport 9418 drop comment "no git daemon"
for p in 3773 40465 20241 20242 20243; do
  sudo nft add rule inet t3agent_egress output meta skuid "$T3AGENT_UID" \
       ip daddr 127.0.0.1 tcp dport "$p" drop comment "no privileged endpoint $p"
done

# ============ 7. Owner approves the NEW relay endpoint; mint AGENT credential only.
#            No executor credential - integration is manual (see section 1). ========

# ============ 8. (RECOMMENDED, needs approval) add swap before running a 2nd instance
```

## 5. Final rollback commands

```bash
# 1. stop the isolated stack (distinct from the privileged one)
sudo pkill -u t3agent -f 't3 serve'
sudo pkill -u t3agent -f 'opencode serve'

# 2. remove egress rules - the whole table. The tailscale INPUT chain is a different
#    table and is NOT touched. Verify before and after.
sudo nft list tables | grep t3agent_egress        # present before
sudo nft delete table inet t3agent_egress
sudo nft list tables | grep t3agent_egress || echo "removed cleanly"

# 3. revoke the agent credential - do not leave it dangling
t3 auth session revoke <agent-session-id>
#    (there is NO executor credential to revoke - design removed in section 1)

# 4. drop the credential from Convex and restore the previous value
npx convex env set T3_MCP_TOKEN <previous-value>

# 5. remove account and all state
sudo userdel -r t3agent

# 6. remove the shared stack
sudo rm -rf /opt/t3agent-stack

# 7. confirm the privileged instance is untouched
ss -ltnp | grep 3773
ps -o user,pid,args -p 1315586
git -C /home/ubuntu/projects/helm status
git -C /home/ubuntu/projects/helm remote get-url origin      # still github
cat /home/ubuntu/.t3/userdata/environment-id                  # still 99a3aad4-…
sudo nft list tables                                          # tailscale table intact
```

## 6. Isolation tests

Three families. **All must pass before any agent thread is launched.** V11 is last
because a negative result without a positive control proves nothing.

### A. Filesystem isolation

```bash
sudo -u t3agent sudo -n true; echo "A1=$?"                    # non-zero: no sudo
id -nG t3agent | tr ' ' '\n' | grep -xE 'sudo|docker|lxd|shadow|disk' \
  ; echo "A2=$?"                                            # non-zero: no priv groups
sudo -u t3agent test -r /var/run/docker.sock; echo "A3=$?"    # non-zero: no docker sock
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519; echo "A4=$?"           # non-zero
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519_abdelilahmortaki; echo "A5=$?"
sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519_modernizer; echo "A6=$?"
sudo -u t3agent cat /home/ubuntu/.config/gh/hosts.yml; echo "A7=$?"        # non-zero
sudo -u t3agent ls /home/ubuntu/projects/helm; echo "A8=$?"               # non-zero
sudo -u t3agent ls /home/ubuntu/.t3/userdata; echo "A9=$?"               # non-zero
sudo -u t3agent cat /home/ubuntu/.t3/userdata/settings.json; echo "A10=$?"# non-zero
sudo -u t3agent env | grep -E '^(HOME|PATH)='                            # own paths only
stat -c '%a %U' /home/t3agent/.t3/userdata/settings.json                 # expect 600 t3agent
```

### B. Credential isolation

```bash
# distinct identity - reusing it would impersonate the privileged instance
diff <(cat /home/ubuntu/.t3/userdata/environment-id) \
     <(sudo -u t3agent cat /home/t3agent/.t3/userdata/environment-id) \
  ; echo "B1=$? (non-zero REQUIRED)"
# no inherited state
sudo -u t3agent ls -la /home/t3agent/.t3/userdata/ | grep -E 'state.*sqlite|secrets'
sudo -u t3agent test -s /home/t3agent/.t3/userdata/secrets \
  && sudo -u t3agent ls /home/t3agent/.t3/userdata/secrets | wc -l
# only disposable projects registered - no real repo path may appear
sudo -u t3agent env HOME=/home/t3agent \
  /opt/t3agent-stack/t3/0.0.46-nightly.20261009.2873/t3 project list \
  | grep -E '/home/ubuntu/projects' ; echo "B4=$? (non-zero REQUIRED)"
# the agent credential must carry ONLY orchestration scopes
#   -> inspect the token response scope field; it must NOT contain source-control:write
```

### C. Control-endpoint isolation (both routes)

```bash
# C1 loopback: privileged T3 control endpoint - MUST fail
sudo -u t3agent bash -c 'exec 3<>/dev/tcp/127.0.0.1/3773';  echo "C1=$? (non-zero REQUIRED)"
# C2 loopback: privileged opencode serve - MUST fail
sudo -u t3agent bash -c 'exec 3<>/dev/tcp/127.0.0.1/40465'; echo "C2=$? (non-zero REQUIRED)"
# C3 loopback: cloudflared tunnel ports - MUST fail
for p in 20241 20242 20243; do
  sudo -u t3agent bash -c "exec 3<>/dev/tcp/127.0.0.1/$p"; echo "C3.$p=$?"
done
# C4 SSH egress blocked - MUST fail
sudo -u t3agent bash -c 'exec 3<>/dev/tcp/github.com/22'; echo "C4=$? (non-zero REQUIRED)"
# C5 PUBLIC RELAY ROUTE: reachable at the network layer BY DESIGN, so assert the
#    CONTROL rather than the connection: reachable but UNAUTHENTICATED.
curl -s -o /dev/null -w '%{http_code}\n' https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp
#    expected: 401 / invalid_mcp_credential -- NOT a success, and never 200
# C6 model access MUST still work (the whole point of the exercise)
sudo -u t3agent env HOME=/home/t3agent <launch a trivial agent thread>
#    expected: model responds; T3 MCP reachable from the isolated instance
```

`C5` is the honest encoding of the limitation: the public relay is **not** network-blocked
and cannot be, so the test asserts that it is **unauthenticated** rather than unreachable.

### D. Positive control and measurement

```bash
# D1 loopback git server; push WITH a t3agent-owned key -> MUST SUCCEED.
#    Without this, every "push was blocked" result is meaningless.
# D2 negative: same server, key absent -> MUST fail at AUTHENTICATION.
# D3 measure the fresh instance (the figure revision 3 could not obtain)
ps -eo user,rss,args | grep -E 't3 serve|opencode serve' | grep -v grep
for p in $(pgrep -u t3agent); do awk '/VmHWM/{print "  pid='"$p"' peak="$2/1024"MB"}' /proc/$p/status; done
du -sh /home/t3agent/.t3
free -h
```

## 7. Stays open

- **EGA-677 criterion 4 remains OPEN.** Nothing here is implemented or proven.
- **`convex/credentials.ts` / `convex/launchAttempts.ts` remain UNWIRED** — unit-tested
  only; no dispatch path calls them.
- **Changing the environment default `runtimeMode` is NOT a fix.**
- **Fresh-instance peak memory is UNMEASURED** until D3.
- **State-database growth is UNMEASURED.**
- **No swap exists** — an OOM is a hard kill.
- **The public relay route is credential-gated, not network-gated.**
- **HTTPS real-remote pushes remain possible in principle**; credential absence is the
  only control.

## 8. Decisions needed

1. **Approve the empty-state second instance?** ~1.5 GB peak RAM (projected), ~600–700 MB
   disk, one new relay identity needing your OAuth approval, two nightly stacks to update.
2. **Approve adding 2 GB swap first?** Strongly recommended — currently there is no OOM
   buffer at all.
3. **Approve the nftables per-uid output table?** Per-user only, separate table,
   tailscale's input chain untouched, no flush.
4. **Accept manual owner-performed integration** replacing the invalid executor
   credential? Slower, but it is the only design not resting on an unverified scope.
5. **Fix the 0664 `settings.json` on the existing instance?** Unrelated, cheap, real
   exposure — still not done.