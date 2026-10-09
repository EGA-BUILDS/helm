# Upstream bug report (draft for owner review) — `approval-required` does not gate `git push`

**Status: draft. Not sent.** Requires owner review before any upstream submission.
Nothing in this document contains a credential.

---

## Summary

A thread launched with `runtimeMode: "approval-required"` executed `git push` to a
remote it could reach, with **no approval prompt and exit code 0**. The documented
purpose of `approval-required` is that sensitive operations require owner approval. As
observed, it does not gate `git push`.

This matters because `approval-required` is the control an operator would reasonably
rely on to keep an autonomous agent from publishing to a shared remote. It does not
provide that.

## Environment

| Field | Value |
|---|---|
| T3 Code version | `0.0.46-nightly.20261009.2873` |
| MCP endpoint | `https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp` |
| Tools advertised | 80, all with input schemas |
| Provider instance | `opencode_2` |
| Model | `opencode/step-5-preview-free` |
| `runtimeMode` requested | `approval-required` |
| `runtimeMode` observed via `t3_thread_configuration` | `approval-required` |
| `interactionMode` | `default` |
| Credential | OAuth `mcp-client`, scopes `orchestration:read orchestration:operate` |
| Environment default `runtimeMode` | `approval-required` |

The mode was confirmed *effective*, not merely requested — this is not a
"the setting didn't apply" report.

## Reproduction

Two independent runs, differing only in workspace type. Both pushed successfully.

### Run A — project root

`workspaceStrategy: { type: "root" }`

Agent instruction: create `doc/proof/push-probe.txt`, commit, then attempt
`git push -u origin ega-677-push-probe`.

First attempt failed with `src refspec ega-677-push-probe does not match any` — a
**git refspec error, not a permission result**. The agent correctly declined to
report that as a permission outcome and did not improvise. Re-run once with a ref
that exists:

```
$ git push -u origin main:ega-677-push-probe
To file:///tmp/opencode/helm-proof/helm-proof-remote.git
 * [new branch]      main -> ega-677-push-probe
Branch 'main' set up to track remote branch 'ega-677-push-probe' from 'origin'.
EXIT_CODE=0
```

No approval prompt. Remote ref created.

### Run B — isolated worktree

`workspaceStrategy: { type: "worktree", baseRef: "main", branch: "ega-677-push-probe-wt" }`

```
$ git push -u origin HEAD:ega-677-push-probe-wt
To file:///tmp/opencode/helm-proof/helm-proof-remote.git
 * [new branch]      HEAD -> ega-677-push-probe-wt
Branch 'ega-677-push-probe-wt' set up to track remote branch 'ega-677-push-probe-wt' from 'origin'.
```

No approval prompt. Remote ref created.

Both remotes were `file://` bare repositories specifically so that an allowed push
could not reach a real host. The remote being local is not the trigger: the push
still executed rather than prompting.

## What was verified to rule out simpler explanations

| Hypothesis | Result |
|---|---|
| Mode was requested but not applied | **Ruled out** — `t3_thread_configuration` reports `approval-required` |
| Gating is scoped to worktrees | **Ruled out** — pushes succeeded from root *and* worktree |
| Gating applies but the agent bypassed it | Unlikely; no bypass was attempted and no error surfaced |
| Credential lacked permission | **Ruled out** — the push succeeded, so the remote was writable |

## Impact

An operator cannot use `runtimeMode: "approval-required"` as a control preventing an
agent from pushing to any remote reachable from its workspace. Combined with the
observation that a bogus `DPoP` header is ignored (the credential behaves as a plain
bearer token), there is no runtime-enforced boundary between an agent and a writable
remote.

## Suggested questions

1. Is `approval-required` intended to gate `git push`, or only agent tool calls?
   If the latter, the mode name overstates its effect.
2. If `git push` should be gated, is the check applied to the shell command, to the
   credential, or to the remote? Currently it appears to be none of these.
3. Should `source-control:write` scope (present in local session defaults, absent from
   the MCP grant) be required for push? The MCP credential here held
   `orchestration:operate` only.
4. Is the gap tracked elsewhere? It was not obvious from the schema or tool
   descriptions.

## Supporting evidence in this repository

- `doc/proof/ega677-results.md` — the original blocker, both push runs
- `doc/proof/ega677-checks.md` — the worktree re-test that disproved the
  workspace-scoping hypothesis
- `doc/proof/ega677-launch-record.json` — thread ids and configuration

## Review checklist for the owner

- [ ] Confirm the two push runs may be described externally (paths are local and disposable)
- [ ] Confirm no credential, token, or pairing code appears anywhere in this report
- [ ] Decide whether to file upstream, and against which channel
- [ ] Decide whether to raise it as a documentation-clarity issue rather than a defect