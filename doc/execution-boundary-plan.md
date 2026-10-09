# Execution boundary — implementation plan (for owner review)

**Status: PLAN ONLY. No infrastructure changed. Nothing deployed.**

Owner constraints honoured throughout: **T3 remains the executor**, **no other
execution server**, **no VM-wide firewall rules**, and **worktrees are never claimed to
provide security isolation**.

---

## Headline finding — the supported runtime cannot enforce this boundary

I inspected the installed T3 (`0.0.46-nightly.20261009.2873`) and the live MCP surface.
The boundary **cannot be enforced by the supported runtime as configured**. Stating that
plainly is the most important result here, because it changes what the plan can promise.

### 1. No MCP tool can set a sandbox or approval policy

Across all 80 tools, only two accept a permission control:

| Tool | Parameter | Values |
|---|---|---|
| `t3_thread_launch` | `runtimeMode` | `approval-required` \| `auto-accept-edits` \| `auto` \| `full-access` |
| `delegate_task` | `runtimeMode` | same, plus `inherit` |

**No tool exposes `sandboxPolicy`, `sandboxMode`, or `approvalPolicy`.** A sandbox policy
does exist in T3's internal runtime policy, and `ProviderSandboxMode`
(`read-only` \| `workspace-write` \| `danger-full-access`) exists as provider-instance
configuration — but neither is reachable from MCP.

### 2. The environment default is `full-access`, and cannot be changed over MCP

```
orchestrator_capabilities -> runtimeMode: "full-access"
binary                    -> DEFAULT_RUNTIME_MODE = "full-access"
```

` t3_environment_preferences_update` can set `defaultThreadEnvMode`,
`newWorktreesStartFromOrigin`, provider update checks, background activity and commit
style. It **cannot** set `runtimeMode`, `approvalPolicy` or any sandbox field.

Consequence: **any launch that omits `runtimeMode` inherits `full-access`.** Helm must
pass it explicitly on every launch, and a bug that drops the field is a silent
escalation to full access rather than a visible failure. This is worth a Helm-side
assertion before every dispatch.

*(This also corrects an earlier error of mine: I had recorded the environment default as
`approval-required`. It is `full-access`. Corrected in `doc/proof/ega677-results.md`.)*

### 3. The `opencode` driver has no OS sandbox — by design

The installed binary states it plainly:

> *"OpenCode does not provide an OS sandbox, so permission rules are also the enforcement
> boundary for non-interactive policies."*

For `opencode_2` (`driverKind: "opencode"` — the provider you authorized), enforcement is
**agent-side permission rules inside the OpenCode process**, not an OS control. It binds
an agent acting in good faith. It does not bind a compromised agent, and it is not a
security boundary against prompt injection.

### 4. The intended mechanism *should* have blocked `git push` — and did not

This is the important nuance, and it revises my earlier bug report.

`OPENCODE_RESTRICTED_PERMISSIONS` **includes `bash`**:

```js
OPENCODE_RESTRICTED_PERMISSIONS = ["bash","edit","webfetch","websearch",
                                   "codesearch","external_directory","doom_loop"]
OPENCODE_ALWAYS_ALLOWED_PERMISSIONS = ["question","read","glob","grep","lsp",
                                       "todowrite","task","skill"]
```

`bash` is not in the always-allowed set, so under `approval-required` the rules built by
`openCodePermissionRules()` should mark it `ask`/`deny`. **But no approval was ever
raised** — I re-read all three proof threads and no permission item exists in any
transcript.

So the design intends to gate `bash`, and empirically it does not. **I have not proven
why.** The leading hypothesis is that the OpenCode session is created with the
environment-default `full-access` rules (`implicitFullAccess` → allow-all) rather than
the per-thread policy, since rules are passed at `session.create`. That is a hypothesis,
not a finding, and it would need T3-side instrumentation to confirm.

This matters for planning: **the boundary may be reachable through a supported mechanism
that is currently mis-wired**, rather than requiring something architecturally new.

---

## What the plan can therefore honestly promise

Given the above, the boundary is built as **capability-by-absence**, not
policy-by-enforcement: the agent is handed a workspace in which nothing valuable is
reachable, rather than being trusted not to reach it.

**And the honest limit:** agents run as the same OS user on the same host as the real
repositories. `~/.ssh`, `~/.netrc`, credential helpers and `/home/ubuntu/projects/helm`
are all reachable by path. Without an OS-level control — which is out of scope by your
instruction — **"the agent holds no credentials" is not currently enforceable.** I will
not claim otherwise.

## Layered design

| Layer | Control | Enforced by | Holds today? |
|---|---|---|---|
| L1 | Agent `origin` is a `file://` bare repo | T3 workspace config | **Yes** — held in both push tests |
| L2 | Real repos never referenced by agent workspace | Helm dispatch code | **Yes**, once Helm stops handing out real paths |
| L3 | Every launch passes `runtimeMode` explicitly | Helm dispatch code | **Yes** — plus a fail-closed assertion |
| L4 | Real push performed by T3, holding credentials, after owner approval | T3 + owner | **Yes**, and the only path to a real push |
| L5 | Agent cannot read VM credentials | OS / different principal | **NO — not enforceable without OS controls** |

L1–L4 are implementable now. **L5 is the hole**, and L1 is what has been quietly
covering it: because the agent's `origin` is local, its pushes had nowhere to go.

### 1. How agents are prevented from accessing VM credentials

Not fully preventable today. Interim measures, in order of value:

- **L1 is the load-bearing control.** A `file://` remote means a push fails at
  transport, before credentials matter.
- **Never register the real checkout as an agent project.** Register only disposable
  clone paths as T3 projects. This keeps real repos out of T3's project registry
  entirely, so no agent thread can be bound to one.
- **Helm never passes a real repo path, remote URL, or branch name into an agent
  prompt.** Target identity is referenced by an opaque attempt id.
- **Document the residual gap:** an agent that decides to read `~/.ssh` can. Today
  nothing stops it.

### 2. How real-remote pushes are blocked while model access still works

Blocking is by **absence of a reachable remote**, not by denying an operation:

- Agent workspace `origin` = `file:///…/helm-proof-remote.git`. No credential exists
  for a `file://` remote, so there is nothing to authenticate with.
- **Model access is unaffected.** The agent reaches the provider API and the T3 MCP
  endpoint over HTTPS, which requires no Git credential at all. These are independent
  paths; blocking Git does not touch model access.
- Helm-side: `prepareLaunchAttempt` refuses to create an attempt whose target remote is
  not on the disposable allowlist. **Fail closed.**

### 3. How owner-authorized Git operations happen through T3

T3 stays the executor; Helm never pushes.

1. Agent produces a change in the disposable clone and reports a diff.
2. Helm presents the diff to you for approval.
3. On approval, **T3** performs the push, holding the real credentials.
4. Helm records the outcome against the attempt id.

The agent is a proposal generator; T3 is the only component that can write to a real
remote. Because L1 means the agent *cannot* push, T3 is the single choke point — which is
what makes owner approval here sufficient rather than decorative.

### 4. How isolation is tested without risking real repositories

Every test uses a **loopback** remote. GitHub is never a test target.

- **Positive control first.** Stand up a loopback SSH git server (`git daemon` or
  `sshd` on `127.0.0.1`) holding a throwaway repo, and push to it **with** a key. If
  that does not succeed, the test harness is broken and any later "push was blocked"
  result is meaningless.
- **Negative test.** Same loopback remote, agent workspace with the key **absent**.
  Assert the push fails at authentication. This proves the control works without GitHub
  being involved.
- **Realism check.** Include one attempt against an `ssh://git@127.0.0.1:PORT/…` URL so
  the test exercises SSH auth failure rather than merely a missing `file://` path.
- **Post-conditions asserted every run:** `git ls-remote` against GitHub shows no new
  refs; the disposable remote gains only expected refs; `/home/ubuntu/projects/helm`
  HEAD, branch and `origin` are unchanged; no file outside the disposable tree is
  modified.
- **Credential canary.** Place a recognisable sentinel in the owner's `~/.ssh` area
  during a test and assert the agent's transcript never contains it. This tests L5
  honestly — **I expect it to fail today**, which is the point of writing it down.

### 5. Hosting changes, operational cost, remaining limitations

**Hosting changes required: none for L1–L4.** No VM firewall, no second execution
server, no provider change. This is deliberate — it keeps the plan reviewable.

**Operational cost:** low. L1–L4 are Helm-side code plus a disposable bare repo per
attempt. The loopback SSH test server is throwaway. No new recurring spend.

**Limitations, stated plainly:**

- **L5 is unenforced.** An agent running as the same user can read `~/.ssh`. This is the
  single largest gap and no in-scope change closes it.
- **Permission rules are agent-side.** They bind good-faith behaviour, not a compromised
  agent.
- **Prompt injection is unaddressed.** L1–L4 bound blast radius; they do not stop an
  agent being convinced to act. A disposable clone keeps the cost near zero.
- **L4 depends on T3 actually performing the push**, which is unproven — no owner-approved
  real push has been executed end to end.
- **Dropping `runtimeMode` silently escalates to `full-access`.** Mitigated by L3's
  fail-closed assertion, not by the runtime.

## Options for closing L5 — your decision, not mine

| Option | Cost | Closes L5? | In scope? |
|---|---|---|---|
| A. Upstream fix: expose `sandboxPolicy`/`approvalPolicy` per launch, and honour per-thread policy at `session.create` | T3 change | Partly — agent-side only | Needs the bug report |
| B. Owner sets environment default `runtimeMode` to `approval-required` in the T3 app UI (not MCP) | Minutes | No — still agent-side, still same user | **Owner action, no infra change** |
| C. Run agents as a dedicated OS user with a scrubbed home | Hosting change | **Yes** | Needs your approval |
| D. Separate host/VM for agent execution | Hosting change | Yes | **Excluded** — you ruled out another execution server |

C is the only option that actually closes L5. It is a hosting change, so per your
instruction I have **not** made it.

## Current wiring status — explicitly unwired

| Component | Status |
|---|---|
| `convex/credentials.ts` | **UNWIRED** — no dispatch path calls it. Unit-tested only. Not exercised against the live endpoint through dispatch. |
| `convex/launchAttempts.ts` | **UNWIRED** — no dispatch path calls it. Unit-tested only. Live fault injection was done with throwaway probe actions, not through this module. |
| `linearGraphql` probe | Internal, read-only, not part of any dispatch path |
| **EGA-677 criterion 4** | **OPEN** — remains open until the boundary is implemented *and proven* |

Neither module may be described as working until a real dispatch exercises it.

## Implementation order

1. **L3 first** — fail-closed assertion that every launch passes `runtimeMode`. Cheap,
   removes a silent-escalation hazard, and is independently valuable.
2. **L1/L2** — disposable-clone-only dispatch, with a fail-closed remote allowlist.
3. **Test harness** — loopback SSH server, positive control, negative test, canary.
   Expect the canary to fail; that failure is the L5 measurement.
4. **Wire** `credentials` and `launchAttempts` into the real dispatch path, then exercise
   them: force an auth failure and confirm dispatch pauses; force a lost acknowledgment
   and confirm reconciliation resolves by unique key with no relaunch.
5. **Only then** assess criterion 4. It closes on evidence from the wired path, not from
   unit tests.

## What I need from you

1. Approve this plan, or tell me what to change.
2. **Option B** (set the environment default in the app UI) — cheap, no infra, your call.
3. Whether to pursue **Option C** (dedicated OS user). It is the only thing that closes
   L5, and it is a hosting change I will not make unilaterally.
4. Whether the upstream bug report should be filed on the revised understanding — the
   mechanism *should* gate `bash` and doesn't, which is a sharper bug than "push wasn't
   gated".