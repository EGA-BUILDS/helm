# Execution-agent remote boundary — proposal

**Status: proposal. Not implemented.** EGA-677 proved that `runtimeMode:
approval-required` does not gate `git push`, from a project root *and* from an isolated
worktree. Worktrees therefore provide **no** remote-containment. This document proposes
a boundary that does not depend on the agent behaving or on a runtime mode being
honoured, while keeping T3 as the Git executor.

The governing principle: **do not make the agent safe. Remove the agent's ability to do
damage.** Every control below holds even if the agent ignores its instructions, retries,
or is prompt-injected.

---

## Why the obvious options fail

| Option | Why it is insufficient |
|---|---|
| Worktree isolation | Proven insufficient. Push executed from a worktree. |
| `approval-required` runtime mode | Proven not to gate push. |
| Instruction: "do not push" | The EGA-677 runs show the agent reporting outcomes honestly, but instructions are not a boundary. |
| Read-only credential | Reduces MCP scope, does not constrain `git` over the network. |
| Credential-less agent | Necessary but **not sufficient** — see residual risk below. |

## The boundary

Four independent layers. Each is cheap; a failure of any one is contained by the rest.

### Layer 1 — The agent holds no Git credentials

The agent process never has anything that can authenticate to a real remote.

- No SSH key, no `~/.ssh`, no `GIT_SSH_COMMAND`, no agent forwarding.
- No PAT, no `.netrc`, no credential helper, no token in the environment.
- No `gh` auth, no cloud credentials.

`origin` for the agent points at a `file://` bare repository. This is what actually
contained both EGA-677 push runs — not policy.

**Consequence:** an agent-side push to a real remote fails at authentication, not at
approval. That is a network/credential fact, which is the class of control that has
actually held so far.

### Layer 2 — Network egress allowlist for agent execution

Enforce outside the agent, where the agent cannot edit it:

- Agent egress permits: the T3 MCP endpoint, the Linear API, and a loopback or
  `file://` path to the disposable remote.
- Agent egress **denies**: `github.com:22`, `github.com:443`, and any host on the
  owner's real-remote list.

Where this must live depends on deployment (see Open questions): a dedicated container
or VM per agent, a `NO_PROXY`-style proxy, or a host firewall. It must **not** live in
anything the agent can write — not in the worktree, not in a shell profile, not in a
repo config file.

Note the git-worktree trap encountered during this proof: git worktrees **share remote
config** with the main checkout, so `git remote set-url` in a worktree silently
repoints the main checkout's `origin`. Any control expressed as repo config is therefore
also a control on the parent repo, and is not a boundary.

### Layer 3 — T3 remains the Git executor

T3 holds the real remote credentials and performs any real push. The agent's role ends
at producing a reviewed artifact.

```
agent (no creds, egress-restricted)
  -> worktree / disposable clone
     -> T3 presents change to owner for approval
        -> T3 (holding creds) performs push
```

The agent never becomes the credential holder; it becomes a proposal generator. This is
the only layer that makes a real push possible at all, which is why it is worth keeping
T3 in the executor seat rather than routing pushes through the agent.

### Layer 4 — Owner approval at the executor, not the agent

Any real push is gated by the owner **at T3**, at the moment of push. Because Layer 1
means the agent cannot push, this is the only place a real push can originate — so this
is the correct and sufficient control point, and it does not depend on the agent's
runtime mode being honoured.

## Residual risk, stated honestly

- **A reachable, credential-less remote is not a real remote.** This holds only while
  the agent genuinely has no credentials. If the agent can reach the owner's `~/.ssh`
  or a credential helper on the host filesystem, Layer 1 collapses. Hence Layer 2.
- **Layer 2 is the load-bearing control.** If it cannot be enforced, Helm must assume
  an agent that is instructed not to push may still push if it can find credentials.
- **Prompt injection** from repository content (issues, files, PR text) is not addressed
  by any layer here. Layers 1 and 2 bound the blast radius; they do not prevent an
  agent from being convinced to act. A disposable clone keeps that cheap.
- **Not tested.** Nothing in Layers 1–3 has been implemented or verified. This is a
  design proposal, and it is gated on the same owner decision as the upstream bug
  report.

## What would make this cheap to adopt

1. Every agent runs in a clone whose `origin` is `file://` — already the shape used in
   the EGA-677 probes.
2. The real target repository is cloned **by T3, not by the agent**, and is never
   mounted into agent-visible space.
3. `credentials` and `launchAttempts` (EGA-677 tasks 4 and 5) already pause dispatch on
   auth failure and prevent blind relaunch, so a paused boundary is observable rather
   than silent.

## Open questions for the owner

1. Can agent egress be restricted on this host at all? If not, Layers 1–2 degrade to
   "trust the agent has no credentials", which is weaker than it sounds.
2. Should Helm refuse to dispatch anything whose target remote it cannot prove is
   unreachable? That is conservative but would block real work today.
3. Is the upstream bug report the preferred route, or should Helm simply treat T3 as
   non-enforcing and design around it permanently?
4. Should the disposable-clone requirement become a hard precondition in the dispatch
   gate, so a misconfigured target fails closed?