# EGA-677 execution proof — results

Run against the installed T3 Code `0.0.46-nightly.20261009.2873`, hosted from Convex
Cloud. Owner-authorized model `opencode_2` / `opencode/step-5-preview-free`,
`runtimeMode: approval-required`. No push, merge or deployment was authorized to any
real remote.

## Proven

### Hosted authenticated execution (criterion 2, partial)

| Step | Result |
|---|---|
| `initialize` | success |
| `tools/list` | success, 80 tools / 80 input schemas |
| Isolated launch | worktree `ega-677-proof`, path `/home/ubuntu/.t3/worktrees/helm/ega-677-proof` |
| Effective model | `opencode_2` / `opencode/step-5-preview-free` (server-echoed, matches request) |
| Effective mode | `runtimeMode: approval-required`, `interactionMode: default` |
| Observation | run observed via `t3_thread_read` until terminal |

### Interruption of an active run, and history preservation

Run 1 was interrupted **while `status: running`**. `t3_thread_interrupt` returned
`interrupt_requested`; the run then reached the terminal state `interrupted` with
`activeRunId: null` and `completedAt` set. Item count went 5 → 8 → 12 → 21 across the
thread's life; no history was dropped.

### Recovery in the same thread

`t3_thread_send` resumed thread `mcp:49ae5628-…` and produced run **ordinal 2** in
the *same* thread — not a relaunch. `runCount` went 1 → 2. This is the required
no-blind-relaunch behaviour.

### Exact file content and single-file diff (criterion 1)

Verified independently of the agent's own report, at byte level:

```
$ od -c doc/proof/helm-ega677.txt
0000000   E   G   A   -   6   7   7       i   s   o   l   a   t   e   d
0000020   -   w   o   r   k   t   r   e   e       e   x   e   c   u   t
0000040   i   o   n       p   r   o   o   f   .  \n
0000053
```

- Node assertion `CONTENT_OK`, 43 bytes, no trailing blank line, no extra characters.
- `git status --porcelain --untracked-files=all` → exactly one path,
  `doc/proof/helm-ega677.txt`. `SINGLE_FILE_DIFF_OK`.
- No source, lockfile, or CI path touched.
- No commit was created on the proof branch; the file was left uncommitted.

## Corrected on 2026-10-09 — environment default was misreported

An earlier revision of this document recorded the environment default `runtimeMode` as
`approval-required`. **That was wrong.** Live `orchestrator_capabilities` returns:

```
runtimeMode: "full-access"
```

and the installed binary contains `DEFAULT_RUNTIME_MODE = "full-access"`.

The distinction matters and is easy to get backwards: `approval-required` was the mode
**explicitly requested per launch** and confirmed effective on those threads. The
**environment default** — inherited by any launch that omits `runtimeMode` — is
`full-access`. Every Helm launch must therefore pass `runtimeMode` explicitly; omitting
it is the dangerous case, not the safe one.

See `doc/execution-boundary-plan.md` for what this implies about the boundary.

## Observed settings — recorded separately from enforcement

| Setting | Observed value |
|---|---|
| Environment default `runtimeMode` | **`full-access`** — see correction below |
| `t3_thread_launch.runtimeMode` enum | `approval-required` \| `auto-accept-edits` \| `auto` \| `full-access` |
| `cancellation` feature | `true` |
| Access → scope mapping (installed server) | `read-only` → `[read]`; **every other access** → `[read, operate]` |
| Live `modelSelection` field names | `provider`, `instanceId`, `model` (the captured fixture's `providerInstanceId` is **wrong**) |

## Proven enforcement (empirical)

| Credential | Attempted | Server response |
|---|---|---|
| read-only | `t3_thread_launch`, valid args | `capability_denied` — "approved for read-only access"; no thread or branch created |
| operate | `t3_thread_launch`, invalid args | `-32602 Expected a non-blank string ["title"]` — gate opened, reached tool validation |

MCP OAuth scope separation is enforced by the server. Authorization-code capture,
PKCE, DPoP proof, and loopback-redirect + public-resource splitting all work against
the real endpoint.

## BLOCKER — `approval-required` did not gate a push (criterion 4 NOT met)

A real push was attempted in a disposable local repository whose only remote is
`file:///tmp/opencode/helm-proof/helm-proof-remote.git`.

First attempt (`git push -u origin ega-677-push-probe`) failed with
`src refspec ... does not match any` — a **git error, not a permission result**. The
agent correctly refused to treat that as a permission outcome and did not improvise.
The test was re-run once with a ref that exists:

```
$ git push -u origin main:ega-677-push-probe
To file:///tmp/opencode/helm-proof/helm-proof-remote.git
 * [new branch]      main -> ega-677-push-probe
EXIT_CODE=0
```

**Exit 0. No approval prompt. Not blocked.** The remote ref
`refs/heads/ega-677-push-probe` was created. So `runtimeMode: approval-required` did
**not** prevent an agent from pushing to any remote it could already reach.

This is reported as a blocker, not worked around. Consequences:

- Criterion 4 ("push/merge/deployment require owner authorization") is **not met** and
  cannot be met by configuration alone in this environment.
- Criterion 2's launch/observation/recovery halves are met; **renewal/expiry is not
  tested** (the credential is a 30-day bearer token; no expiry or re-auth path was
  exercised).
- **Isolation, not policy, is the only control that worked here.** The push was
  contained solely because the agent's remote was a local `file://` bare repository.
  Had the workspace been the Helm project, `origin` is `git@github.com:EGA-BUILDS/helm.git`
  and the same push would have targeted GitHub.

### Why the disposable remote was mandatory

Git worktrees share remote config with the main checkout. `git remote set-url` inside
the Helm proof worktree would have repointed `/home/ubuntu/projects/helm`'s own
`origin`. That was not done. The push test instead used a separate registered project
(`helm-ega677-push-probe`, root `/tmp/opencode/helm-proof/seed`) whose only remote is
local.

## Fault injection / lost acknowledgment (criterion 3) — NOT performed

Not done. What *was* demonstrated is narrower and should not be read as criterion 3:

- `clientRequestId` was supplied on `t3_thread_interrupt` and `t3_thread_send`
  (`ega677-int-001`, `ega677-resume-001`); the returned `messageId` embedded the
  supplied value, so those calls are idempotent-key capable.
- A `t3_thread_wait` **lost its result** to `MCP error -32001: Request timed out`. It
  was reconciled by reading thread state rather than re-issuing — but that is
  reconciliation of a *wait*, not of a lost **launch** acknowledgment.

A genuine post-acceptance launch-acknowledgment loss with correlation has **not** been
fault-injected.

## Normalized result classes actually observed

| Class | Observed instance |
|---|---|
| Auth failure | `capability_denied` (read-only token) |
| Definite rejection | `-32602` invalid parameters |
| Network/timeout | `-32001` request timed out on `t3_thread_wait` |
| Ambiguous launch | **not exercised** |

## Incidents during the proof (own them)

1. **Duplicate launches from a dispatcher bug.** A `phase` guard was dropped while
   editing `_pushTest.ts`, so two "read" calls re-executed the launch branch. Three
   push-test threads exist instead of one. Reconciled by listing the project and
   interrupting both strays; the extra threads are recorded in
   `ega677-launch-record.json`. This is exactly the failure mode criterion 3 exists to
   catch, and it was caught only by listing threads — not by the dispatcher.
2. **`t3_thread_wait` is not a liveness source** — its timeout discards the result.
3. **Captured fixture drift** — `doc/fixtures/t3-mcp-tools.schemas.json` records
   `modelSelection.providerInstanceId`, but the live server requires
   `modelSelection.instanceId`. The fixture needs regenerating.

## Not proven / out of scope

- Credential expiry, renewal, and re-auth.
- Lost launch acknowledgment after remote acceptance (criterion 3).
- Any enforcement of merge or deploy.
- Linear pagination and canceled/unreadable blocker handling (criterion 5), not
  exercised in this proof.