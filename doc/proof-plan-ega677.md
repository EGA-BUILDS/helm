# EGA-677 disposable execution proof — pending model confirmation

**Status: PREPARED. NOT LAUNCHED.** Awaiting the owner's explicit provider/model
confirmation. No thread exists, no branch was created, Helm `main` is untouched.

## Credential state

| Credential | Scopes | Where | Status |
|---|---|---|---|
| read-only | `orchestration:read` | Convex env (replaced, backed up) / `helm-mcp-hosted.state.json` | Retained, **not revoked** |
| operate | `orchestration:read orchestration:operate` | Convex `T3_MCP_TOKEN` / `helm-proof.state.json` | Verified working |

Operate credential re-verified from **hosted Convex** after the swap:

```
initialize   : success
tools/list   : success
server       : T3 Code 0.0.46-nightly.20261009.2873
toolCount    : 80   toolsWithInputSchema: 80
```

## Observed settings (recorded separately from enforcement)

These are values **observed** from the T3 environment. They are not proof that
anything is enforced; enforcement is proven separately below.

| Setting | Observed value | Source |
|---|---|---|
| Environment default `runtimeMode` | `approval-required` | `orchestrator_capabilities` (hosted) |
| Environment default `interactionMode` | `default` | `orchestrator_capabilities` (hosted) |
| `t3_thread_launch.runtimeMode` enum | `approval-required`, `auto-accept-edits`, `auto`, `full-access` | `tools/list` schema |
| `cancellation` feature | `true` | `orchestrator_capabilities.features` |
| Access → scope mapping | `read-only` → `[read]`; **every other access** → `[read, operate]` | installed server source |

Note the last row: the approval access selector does **not** by itself gate Git.
Any non-`read-only` grant carries operate scope. What gates push/merge/deploy is
the **runtime mode the launched agent runs under**, which the proof must observe
via `t3_thread_configuration` after launch.

## Proven enforcement (empirical, both directions)

Both run from the hosted Convex runtime against the real server:

| Credential | Attempted | Server response | Conclusion |
|---|---|---|---|
| read-only | `t3_thread_launch` (valid args) | `capability_denied` — *"This tool changes the environment, and this MCP client was approved for read-only access."* | Scope **is** enforced at runtime; no thread or branch created |
| operate | `t3_thread_launch` (deliberately invalid args) | `-32602 Invalid parameters … Expected a non-blank string ["title"]` | Capability gate **opened**; request reached tool validation |

Scope enforcement is therefore demonstrated by the server, not assumed from the
prompt or the environment default.

## Target

- Project `7cc5a103-036e-43c5-be4e-65b0c53be1b4` (`ega-builds/helm`)
- Workspace: **new worktree**, `workspaceStrategy: {type:"worktree", baseRef:"main", branch:"ega-677-proof"}`
- Helm `main` and `/home/ubuntu/projects/helm` are not modified by the proof.

## The change under test

1. Create `doc/proof/helm-ega677.txt` containing exactly one agreed line.
2. Assert the content with a small Node check.
3. Assert the diff contains **only** that one file.

No source, lockfile, or CI changes.

## Planned lifecycle (not yet executed)

1. `t3_thread_launch` → capture thread ID, worktree path, runtime mode.
2. `t3_thread_configuration` → **confirm `runtimeMode: approval-required`**; abort if not.
3. `t3_thread_wait` → observe; then `t3_thread_interrupt` with a `clientRequestId`
   **while the run is active**.
4. `t3_thread_read` → confirm history preserved and interrupted state visible.
5. Recovery in the **same thread** via `t3_thread_send` — never a fresh launch.
   If any outcome is ambiguous, stop and reconcile; no blind retry.
6. Verify exact file content and single-file diff.

## Outstanding owner input

**Provider/model — not yet confirmed.** The owner must choose one; no
substitution will be made:

- `opencode_2` / `opencode/step-5-preview-free` (free)
- `codex` / `gpt-6.1-sol`
- `claudeAgent` / `claude-haiku-5-5` (cheapest Claude)

## Still unproven after this proof

Launching proves nothing about dispatch correctness. EGA-677 acceptance items
2–4 (hosted launch, lost-acknowledgment fault injection, repository/push
controls) remain open until this proof completes, and item 4 additionally needs
a real push attempt to be *observed as blocked*.