# Dedicated-user deployment plan (for owner review)

**Status: PLAN ONLY. Nothing installed, no users created, no services changed.**
Keep T3 as the executor. No VM-wide firewall rules. Worktrees are not treated as
isolation. **Criterion 4 stays open.**

---

## Does this need a separate T3 instance? — Yes, unavoidably

**Yes.** Not a preference — a consequence of how T3 is architected.

Evidence gathered on this host (read-only):

| Observation | Implication |
|---|---|
| T3 state lives in `/home/ubuntu/.t3/userdata/` (`statev2.sqlite` 3.6 GB, `state.sqlite` 1.8 GB) | Per-OS-user. A second user gets a second, independent database. |
| `server-runtime.json` shows `t3 serve` on port 3773, **pid 1315586**, owner `ubuntu` | One server per data dir. |
| `opencode serve --hostname=127.0.0.1 --port=40465` (pid 1323128) is a **child of `t3 serve`** | Provider processes inherit the T3 process user. |
| Provider binaries are absolute paths under ubuntu's home: `binaryPath: /home/ubuntu/.opencode/bin/opencode` | Unreadable from another user. The second instance needs its own binary. |
| `environment-id` = `99a3aad4-7cb4-4177-9a7e-b445dc19db07`, label `openclaw` | One identity per instance. |
| Relay host and environment-id both live in that instance's own DB (140 and 320 references) | MCP endpoint is per-instance state. |

There is **no supported way for one T3 instance to serve two OS users**: its state,
credentials, provider binaries and identity all live inside one user's home. A separate
OS user therefore *implies* a separate T3 instance.

### The tradeoff, stated before anything is built

**What a second instance costs**

1. **A new identity, and a new OAuth approval from you.** A fresh data dir means a new
   `environment-id`. The hosted MCP endpoint is per-instance state, so the second
   instance will have its own relay host, its own issuer, and its own `mcp-client`
   credential. **You would have to repeat the pairing-and-approval dance** and hand Helm
   a second credential. That is a new secret to store, rotate and eventually revoke.
2. **A second ~5.4 GB state database.** 75 GB free, so feasible, but it grows and needs
   its own cleanup.
3. **Two instances to operate.** The build is a `0.0.46-nightly.*` — the version changes
   under you. Two instances means two update cycles, two failure surfaces, two log
   streams, and two things to patch when a nightly regresses.
4. **Two operator-facing apps.** You approve things in a second T3 instance. That is
   real ongoing attention, not a one-off.
5. **Unknown until proven.** I could **not** confirm how the relay hostname is derived.
   I hypothesised `sha256(environmentId)[:12]` from the binary, computed it, and it did
   **not** match the live host (`80c95f749be9` vs `e0eb33007bdbf8c3`). So the derivation
   is something else. Consequence: I am **not** promising the second instance gets a
   clean separate endpoint — it might collide, or need re-registration. Step 6 below
   exists to settle this empirically, and it needs your approval before it can.

**What it buys**

Genuine filesystem and credential isolation, verified below. It closes L5 — the one gap
that cannot be closed in application code.

**Honest summary:** this is a real ongoing cost, bought with a security property that
nothing else in the current system can provide. I think it is worth it, but it is your
call, and I am not going to soften the operational side.

---

## Verification 1 — which processes run under the isolated user

All of these, and nothing else:

| Process | Runs as | Notes |
|---|---|---|
| `t3 __service-launcher` | `t3agent` | Second instance, own data dir |
| `t3 serve` | `t3agent` | Own port (not 3773) |
| `t3-resource-monitor/linux-arm64/…` | `t3agent` | Child of `t3 serve` |
| `opencode serve --hostname=127.0.0.1 --port <free>` | `t3agent` | Child of `t3 serve`, own port |
| Convex-hosted Helm actions | n/a | Run in Convex Cloud, not on this host |

**Explicitly NOT under `t3agent`:** the existing `ubuntu` T3 instance, the interactive
T3 Code app you use, and anything you run by hand.

Isolation is per-process-ownership, which is exactly the boundary that matters: a process
owned by `t3agent` cannot read files mode-restricted to `ubuntu`.

## Verification 2 — they cannot read ubuntu's SSH keys, tokens or real repos

This is the strongest result in the plan, and it rests on a fact already true today:

```
drwxr-x--- 138 ubuntu ubuntu  /home/ubuntu          <-- 0750
drwx------   2 ubuntu ubuntu  /home/ubuntu/.ssh     <-- 0700
-rw-------       ubuntu ubuntu  /home/ubuntu/.ssh/id_ed25519
-rw-------       ubuntu ubuntu  /home/ubuntu/.config/gh/hosts.yml
drwxr-xr-x       ubuntu ubuntu  /home/ubuntu/projects/helm
```

`/home/ubuntu` is mode **0750**, group `ubuntu`. A `t3agent` user is not in that group,
so **it cannot traverse into the directory at all** — it cannot read the SSH keys, the
`gh` token, the real repos, or T3's own data dir. Not "cannot use them": cannot open them.

What `t3agent` **cannot** reach: `id_ed25519` and the three other private keys,
`known_hosts`, `.config/gh/hosts.yml`, `/home/ubuntu/projects/helm` and every other real
repo, `~/.t3/userdata/secrets/` (0700), and `~/.t3/userdata/settings.json`.

### Two fragilities in this, both documented rather than hidden

1. **The entire boundary rests on one directory mode.** `/home/ubuntu` being 0750 is the
   only thing preventing access. If it is ever `chmod 755` — by an installer, a
   convenience change, or a backup tool — the boundary **silently evaporates**. The plan
   must include a standing check on this mode.
2. **`/home/ubuntu/projects` is `drwxrwxr-x ubuntu:docker`** — world-traversable. It is
   protected *only* by the parent. That parent is load-bearing.

### Incidental finding worth fixing regardless

```
-rw-rw-r-- ubuntu ubuntu /home/ubuntu/.t3/userdata/settings.json
```

**Mode 0664 — world-readable — and it contains `serverPassword` and `apiKey` fields.**
The `secrets/` directory is correctly 0700, but this file is not. On any multi-user box
those two values are readable by every account. Recommend `chmod 600` on the existing
instance too. This is independent of the dedicated-user work and I have **not** changed
it.

## Verification 3 — model authentication without Git credentials

These are independent paths, which is why separating them costs nothing.

- **Model/provider access**: `t3agent` needs its own `settings.json` with its own
  `opencode_2` instance, and its own copy of the opencode binary at a path it can read
  (e.g. `/home/t3agent/.opencode/bin/opencode`). Provider credentials — whatever
  `opencode_2` actually uses — are supplied **only** to `t3agent`. Note
  `opencode_2` currently has no API key in `settings.json`; if it turns out to rely on
  ambient state under `/home/ubuntu`, it will need an explicit per-user credential.
- **MCP credential**: a second OAuth `mcp-client` credential for the second instance's
  relay endpoint. Stored only in the second instance's `secrets/` (0700).
- **Git access**: `t3agent` gets **no** SSH key, no `gh` auth, no credential helper, no
  `.netrc`. Its only remote is a `file://` bare repo, which needs no credential at all.

Nothing about model auth implies Git auth. An HTTPS call to a model endpoint and an SSH
call to GitHub use different credentials, and only the second is withheld.

## Verification 4 — how network access prevents unauthorized real-remote writes

**Direct answer: network access does not prevent them, and it is not the control.**

A separate OS user on the same host still has full network access. `github.com:22` and
`:443` remain reachable from `t3agent`. The control that matters is **credential
absence**: with no SSH key and no `gh` token, a push to a real remote fails at
authentication regardless of reachability.

So the honest ordering:

1. **Primary — no credentials.** Push fails at auth. This is what holds.
2. **Secondary — the agent's only remote is `file://`.** A push has nowhere to land.
3. **Tertiary — network egress filtering.** *Not implemented, and deliberately so.*
   VM-wide firewall rules are out of scope by your instruction.

If you later want layer 3, the options that are **not** VM-wide are a per-user egress
proxy or a dedicated network namespace for `t3agent`'s services. Both are real work and
both can be bypassed by an agent that controls its own environment, so I would not treat
them as load-bearing. Recorded as an open decision, not a recommendation.

**Residual risk I am not claiming away:** an agent with network access and no credentials
can still exfiltrate anything it can read, and could authenticate to a remote using
credentials it obtains from somewhere else on the host. Layers 1–2 bound this; they do
not eliminate it. Network egress control is the only thing that addresses it, and it is
out of scope here.

## Verification 5 — how owner-approved integration happens through T3

T3 stays the executor. Helm never pushes.

1. Agent (as `t3agent`, in a disposable `file://` clone) produces a change and reports a diff.
2. Helm surfaces the diff and attempt id to you.
3. **You approve.**
4. **T3, under the `ubuntu` instance which holds the real credentials, performs the push.**
5. Helm records the outcome against the attempt id.

The agent *cannot* push (no credentials, `file://` only), so the `ubuntu` instance is the
single choke point where a real write can happen — which is what makes your approval
meaningful rather than decorative.

**Unproven:** no owner-approved real push has been executed end to end. Step 8 below is
the first time this path runs for real, and it should be treated as a live test.

## Installation commands (NOT YET RUN)

```bash
# 1. Create the service account. NO sudo group, NO docker, nologin-adjacent shell.
sudo useradd --create-home --home-dir /home/t3agent \
             --shell /usr/sbin/nologin --user-group t3agent

# 2. Install a private opencode binary readable only by t3agent.
sudo -u t3agent mkdir -p /home/t3agent/.opencode/bin
# (binary copied from the existing install; never world-readable)

# 3. Give t3agent ONLY the disposable remote area.
sudo -u t3agent mkdir -p /home/t3agent/remotes /home/t3agent/worktrees
sudo chmod 700 /home/t3agent/remotes

# 4. Point the second instance at its own data dir and a free port.
export T3CODE_HOME=/home/t3agent/.t3
# run: t3 serve --port <free-port>   (NOT 3773)

# 5. Register ONLY disposable projects — never a real repo path.
#    Verify with: sudo -u t3agent t3 project list

# 6. Owner mints a pairing code for the SECOND relay endpoint and approves it.
#    (New OAuth approval required — see the tradeoff section.)

# 7. Point Helm at the new endpoint with the new credential.
#    Keep the existing read-only credential as fallback.

# 8. Ownership hardening, applied to the new instance only.
sudo chown -R t3agent:t3agent /home/t3agent/.t3
sudo chmod 700 /home/t3agent/.t3 /home/t3agent/.t3/userdata
sudo chmod 600 /home/t3agent/.t3/userdata/settings.json   # avoid the 0664 issue
```

**Deliberately absent:** no `iptables`/`ufw`/`nft` commands, no changes to the `ubuntu`
instance, no changes to `/home/ubuntu` permissions, no changes to any real repository.

## Rollback

Fully reversible, because nothing outside `/home/t3agent` is touched.

```bash
# Stop the second instance (it is a distinct service, not the primary one)
sudo pkill -u t3agent -f 't3 serve'
sudo pkill -u t3agent -f 'opencode serve'

# Remove the credential from Convex and revoke the second session
#   t3 auth session revoke <second-session-id>
#   unset T3_MCP_TOKEN on the deployment; restore the previous credential

# Archive or delete the account and all its state
sudo userdel -r t3agent          # -r removes /home/t3agent

# Verify the primary instance is untouched
systemctl status <primary-t3-service>
git -C /home/ubuntu/projects/helm status
```

Rollback risk is low. The one irreversible-ish item is the **second OAuth credential**,
which should be revoked explicitly rather than left dangling — a credential nobody
remembers revoking is exactly the kind of thing that outlives its purpose.

## Realistic verification sequence

Ordered so that each step proves the previous one before spending the next.

| # | Step | Passes when |
|---|---|---|
| 1 | `sudo -u t3agent cat /home/ubuntu/.ssh/id_ed25519` | **Fails** with permission denied |
| 2 | `sudo -u t3agent ls /home/ubuntu/projects/helm` | **Fails** |
| 3 | `sudo -u t3agent cat /home/ubuntu/.config/gh/hosts.yml` | **Fails** |
| 4 | `sudo -u t3agent cat /home/ubuntu/.t3/userdata/secrets/<any>` | **Fails** |
| 5 | Stand up a **loopback** git server; push **with** a `t3agent`-owned key | **Succeeds** — proves the harness works, so later failures mean something |
| 6 | Launch an agent thread as `t3agent` against an `ssh://git@127.0.0.1:PORT/…` origin | Push **fails at auth**, not silently |
| 7 | Canary: sentinel in `t3agent`'s reachable paths; assert absent from every transcript | Never appears |
| 8 | Owner-approved real push via the `ubuntu` instance | Succeeds **once**, only after approval |
| 9 | Post-conditions: GitHub refs unchanged, `/home/ubuntu/projects/helm` HEAD/branch/`origin` unchanged, `origin/main` untouched | All hold |

**Step 5 before step 6 is not optional.** Without a positive control, "the push was
blocked" is indistinguishable from "the harness was broken" — which is precisely the trap
in the first push test, where a refspec error was initially mistaken for a permission
result.

Steps 1–4, 7 and 9 are safe and involve nothing real. Step 5 uses loopback only.
**Step 8 is the first step that touches a real remote** and should be gated on your
explicit go-ahead.

## What stays open

- **EGA-677 criterion 4 remains OPEN.** Nothing above is implemented or proven. The plan
  describes a boundary; a plan is not a control.
- **`convex/credentials.ts` and `convex/launchAttempts.ts` remain UNWIRED.** Unit-tested
  only. No dispatch path calls them. They must not be described as working until a real
  dispatch exercises them — including a forced auth failure (expect dispatch to pause)
  and a forced lost acknowledgment (expect unique-key reconciliation with no relaunch).
- **Changing the environment default `runtimeMode` is not a fix.** The demonstrated
  failure is that `bash` is gated by design and an approval was never raised. Setting a
  default does not address that, and I am not proposing it as a remedy.
- **The relay-derivation question is unanswered.** Step 6 settles it empirically.

## Decisions I need from you

1. **Approve the second-instance tradeoff?** It buys real isolation at the cost of a
   second identity requiring your OAuth approval, ~5.4 GB, and double the operational
   surface on a nightly build. If the answer is no, the honest consequence is that
   criterion 4 stays permanently unprovable in this environment.
2. **Fix the 0664 `settings.json`?** Unrelated to this plan, cheap, and a real exposure.
3. **Per-user network egress filtering** — wanted later, or explicitly out of scope?
4. **File the upstream bug report** on the revised understanding (`bash` is restricted by
   design yet no approval was raised)?