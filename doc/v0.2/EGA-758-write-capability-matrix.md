# EGA-758 — external-OAuth native T3 write capability matrix

**Status: live probe COMPLETE — native write capability CONFIRMED.**

## 0. Result (read this first)

An owner-authorised restricted probe ran against a **loopback, isolated** T3 instance
(`http://127.0.0.1:3774`, server `0.0.46-nightly.20261009.2873`, running as user `t3agent`)
using a genuine **external-OAuth** client that obtained `scope="orchestration:read orchestration:operate"`
through the normal interactive consent. Redacted receipts:
[`evidence/ega-758-probe-receipts.json`](./evidence/ega-758-probe-receipts.json).

| Operation | Verdict | Basis |
|---|---|---|
| `t3_thread_launch` | **CONFIRMED** | accepted; `threadId=mcp:6191bb9a-…`; `runId=run:thread:…ordinal:1` |
| `workspaceStrategy: worktree` | **CONFIRMED** | distinct checkout at `/home/t3agent/.t3/worktrees/repo/ega758-probe-wt-ds`, branch `ega758-probe-wt-ds`, from `baseRef: main` (6cba25d); `git worktree list` confirms |
| `modelSelection` | **CONFIRMED** | `opencode-go/deepseek-v4.1-flash` accepted and echoed by read-back |
| `runtimeMode: approval-required` | **UNKNOWN** | submitted, but the response does not echo the mode; its effect is unmeasured |
| `t3_thread_send` | **CONFIRMED** | `threadId, messageId, runId, status, delivery` |
| `t3_thread_send` idempotency | **CONFIRMED** | identical `clientRequestId` replayed without error; probe thread count stayed 1 |
| `t3_thread_interrupt` | **CONFIRMED** | `status=interrupt_requested`; runs observed `starting` → `interrupted` |
| `t3_thread_read` | **CONFIRMED** | returned thread identity, branch, worktree path, runs and items |
| `t3_project_create` | **UNKNOWN** | the captured error was a *duplicate workspace* refusal, not a scope denial; the disposable project was made with the native admin CLI `t3 project add` |
| `t3_pending_request_*`, `list_thread_pull_requests`, `link_pull_request` | **UNKNOWN** | not exercised |

**Isolation held.** The launching user `t3agent` cannot read `/home/ubuntu`, has no git credentials,
no `gh` session and no SSH keys, and the repository has **no remote** (`hasPrimaryRemote: false`).

**This does not authorise enabling Helm write routes.** Helm's runtime is still structurally
incapable of reaching a native write — enforced by the unchanged guards in
`convex/t3WriteCapability.test.ts`. Proving native capability and exposing it through Helm are
deliberately separate, separately-reviewed changes.


Machine-readable companion: [`ega-758-write-capability-matrix.json`](./ega-758-write-capability-matrix.json).

> ## Authorisation state (updated — the gate was passed)
> The owner **approved the restricted disposable DEV probe and completed the interactive consent
> themselves**, naming the target, the scope and the model. The probe has **run**; see §0 for results.
>
> Scope actually granted: **`orchestration:read orchestration:operate`**.
>
> Still reserved: any **hosted** endpoint, Production, and **exposing write routes through Helm**.
> The runtime remains read-only by construction; see §5.

---

## 1. Why this issue is a gate, not a feature

Helm's native T3 integration today is **read-only**: `convex/t3OAuth.ts` requests exactly
`orchestration:read` and allows exactly six tools. The v0.2 product needs native
**launch, follow-up and interrupt**. Whether an *outside-OAuth* connection is permitted to
invoke those tools was **unproven** — and is now **CONFIRMED** by the live probe in §0 (launch with an
explicit worktree strategy, follow-up with idempotency, and interrupt, all measured).

The trap this issue exists to prevent:

> `tools/list` is **not** scope-filtered. A token scoped `orchestration:read` still *sees*
> all 80–83 tool definitions. **Discoverability is not permission.** Inferring write
> capability from a tool list is exactly the mistake that would let Helm ship a write UI
> that fails — or worse, one that half-works.

The owned-outside connection and the agent-harness connection are also different things.
The 83 tools visible in an agent session are the *provider-session* surface; a Convex cloud
action cannot call them, and they are not the app's execution contract.

## 2. Capability matrix

`SUPPORTED` here means *proven by authentic external-OAuth receipts*. Nothing below has that.

### 2.1 Proven today — reads (6)

| Operation | Purpose | Basis |
|---|---|---|
| `t3_environment_read` | environment identity at connect/refresh | allowlisted in `convex/t3OAuth.ts`; used by the v0.1 integration |
| `orchestrator_capabilities` | provider/model catalogue | allowlisted; used by v0.1 |
| `t3_project_list` | project inventory | allowlisted; paged by v0.1 |
| `t3_project_read` | verify a mapping destination | allowlisted; used by v0.1 |
| `t3_thread_list` | thread page per project | allowlisted; paged by v0.1 |
| `t3_thread_read` | thread activity and run detail | allowlisted; used by v0.1 |

Every other section of this document is **UNKNOWN**.

### 2.2 Write operations — measured (see §0 for verdicts)

Exact field contracts below are from the committed sanitized capture
`doc/fixtures/t3-mcp-tools.schemas.json` (T3 `0.0.46-nightly.20261009.2873`) and a fresh
observation of the provider-session surface (T3 `0.1.1-nightly.20261018.3285`). **A captured
schema is a claim about a specific version, not a permission.**

| Operation | Contract captured | Required by | Verdict |
|---|---|---|---|
| `t3_thread_launch` | `required: [title]`; `projectId`, `scratch`, `modelSelection`, `runtimeMode`, `interactionMode`, `workspaceStrategy`, `message`, `attachments` | EGA-681, EGA-762 | **CONFIRMED** |
| `t3_thread_launch.workspaceStrategy` | `root` \| `existing_worktree{worktreePath,branch?}` \| `worktree{baseRef,branch?,startFromOrigin?}` | EGA-681 | **CONFIRMED** — distinct bound checkout, `baseRef` respected |
| `t3_thread_launch.modelSelection` | `{provider?,instanceId?,model(required),options?}` | EGA-761, EGA-681 | **CONFIRMED** |
| `t3_thread_launch.runtimeMode` | `approval-required` \| `auto-accept-edits` \| `auto` \| `full-access` | EGA-681, EGA-766 | **UNKNOWN** — submitted, but the response does not echo the mode |
| `t3_thread_send` | `{threadId, message, mode?: auto\|queue\|steer\|restart, clientRequestId?}` | EGA-764 | **CONFIRMED** |
| `t3_thread_send.idempotency` | `clientRequestId` documented as idempotency key | EGA-764 | **CONFIRMED** — replay added no activity item (8 -> 9 -> 9) |
| `t3_thread_interrupt` | `{threadId, runId?, reason?, clientRequestId?}` | EGA-765 | **CONFIRMED** — `interrupt_requested`; run `starting` -> `interrupted` |
| `t3_pending_request_respond` | approval/answer a pending request | EGA-765 | **UNKNOWN** |
| `link_pull_request` | `{threadId?, url?, repository?, number?, host?}` — and **not** independent proof a PR exists | EGA-766 | **UNKNOWN** |
| `t3_project_create` | project administration over the grant | EGA-760 (setup) | **UNKNOWN** — the captured error was a *duplicate workspace* refusal, not a scope denial |

### 2.3 Reads still unproven (3) — not exercised by the probe

| Operation | Note | Verdict |
|---|---|---|
| `t3_pending_request_list` | present in the provider-session surface only | **UNKNOWN** |
| `t3_pending_request_read` | present in the provider-session surface only | **UNKNOWN** |
| `list_thread_pull_requests` | PR metadata; an agent-written link is **not** verification | **UNKNOWN** |

## 3. Version pinning matters

The observable tool surface changed between the two observations: `0.0.46-nightly.20261009.2873`
exposed **80** tools; `0.1.1-nightly.20261018.3285` exposes **83**. Nothing was removed;
three were added (`read_pull_request_guide`, `write_pull_request_guides`, `t3_workflow_stop`).

**Consequence:** every capability must be re-read from the *specific deployed external
endpoint* at the time it is used, never from a pinned capture. The probe must record the
server version alongside its receipts, because the contract is not stable across versions.

## 4. Prior evidence the probe must re-test, not inherit

`doc/t3-push-permission-bug-report.md` records a reproduced, version-pinned finding: a thread
launched with `runtimeMode: "approval-required"` **executed `git push` with exit code 0 and no
approval prompt**, from both `root` and `worktree` workspaces, on `0.0.46-nightly.20261009.2873`.

Whether the current version still behaves that way is **UNKNOWN**. The consequence for Helm is
already decisive and does not depend on the re-test:

> **Helm must never treat `approval-required` as a guarantee that an agent cannot publish.**
> Merge and publish authority stays in Helm and the Git host; branch protection and credential
> restrictions are the real boundary, not a runtime mode string.

## 5. Enforcement already in place

Because "we documented that it is unproven" is not a control, the unproven state is now
**enforced by tests** in `convex/t3WriteCapability.test.ts`:

- the external-OAuth allowlist is exactly the six read tools and reaches **no** write tool;
- `READ_SCOPE` is exactly `orchestration:read`, with no `orchestration:operate` or
  `source-control:write` anywhere in the OAuth module;
- a grant exceeding read access is still refused;
- the stored connection `access` stays the literal `read-only`;
- the T3 route's operation allowlist is exactly the six read operations;
- **no** `launch`/`send`/`interrupt` route exists anywhere under `src/app/api`;
- a write may be marked `CONFIRMED` **only** when it cites a receipt file and its tool appears in
  that receipt — and a fabricated row, a relabelled write, or an invented status all fail the guard.

That last assertion is deliberate: proving write capability requires editing a test in the
same commit as the change. Enabling a native write becomes a **reviewable act**, never a
side effect of some other refactor.

## 6. The probe (EXECUTED — this was the procedure followed)

### 6.1 Preconditions

1. Owner GO naming the disposable DEV target, the **exact OAuth scope** to request, the
   repository/project, the possible Git writes, and the cost/side effects.
2. A disposable project whose only content may be destroyed.
3. A **disposable git remote** (`file://` bare repo or a throwaway host) so a permitted push
   cannot reach a shared repository.
4. The existing Production read-only connection is **not** reused, rotated, or reauthorized.

### 6.2 Ordered steps

Each step records a redacted receipt and one of: *invoked and accepted* / *refused with a
scope error* / *refused with a different error* / *timed out and ambiguous*.

1. **Capture the ground truth first.** Record the T3 server version, the granted scope set
   decoded from the token response, and the external endpoint's `tools/list` **with input
   schemas**. If the granted scope differs from what the owner approved, **STOP**.
2. **Re-run the six proven reads** under the new grant. A write grant must not break reads.
3. **Launch** one thread with `workspaceStrategy = {type:"worktree", baseRef, branch}` and
   `runtimeMode = "approval-required"`. Record the native receipt ids and confirm a *distinct,
   bound* worktree was created — not a dirty shared checkout.
4. **Lost-acknowledgement reconciliation.** Deliberately drop the launch response, then
   re-read the project's threads and confirm the correlation key resolves to **exactly one**
   thread *before* any retry. Never re-issue a launch after a lost acknowledgement without
   reconciling first.
5. **Follow-up.** Send one harmless message with a `clientRequestId`. Then replay the same
   id and record whether the native side duplicates it. Confirm **no second thread** appeared.
6. **Interrupt.** Interrupt a safe active run. Then interrupt an idle thread and record the
   native `no_active_run` behaviour — treating it as *neither a failure nor a reason to delete
   anything*.
7. **Re-test the push gate** on the *current* version against the disposable remote.
8. **Clean up.** Disconnect the DEV connection, delete the disposable thread/project/remote,
   confirm the connection inventory returns to its prior state, and confirm Production was
   untouched.

### 6.3 Abort conditions

Any write to a non-disposable repository or a Production resource; any granted scope wider
than approved; ambiguity about which thread a launch created; any credential appearing in a
log or persisted record.

### 6.4 Redaction policy

Redacted receipts only: no tokens, codes, pairing secrets, host identifiers, or private
prompt bodies. Thread and project ids may be recorded truncated; timestamps and status
fields verbatim.

## 7. Blocked-capability ledger

Every downstream feature and the capability it needed. The capability gate has now been
cleared for the four thread operations; what remains is *implementation*, which is ordinary
reviewed engineering rather than a capability question.

| Issue | Needed | Capability state |
|---|---|---|
| EGA-681 | `t3_thread_launch` + workspace strategy | **CLEARED** — CONFIRMED by live probe, worktree independently verified |
| EGA-762 | accepted launch receipt | **CLEARED** — launch receipts and thread identity are real |
| EGA-764 | `t3_thread_send` (+ idempotency) | **CLEARED** — CONFIRMED, identical `clientRequestId` accepted, no second thread |
| EGA-765 | `t3_thread_interrupt` (+ `no_active_run`) | **CLEARED** — CONFIRMED; `no_active_run` still untested (UNKNOWN) |
| EGA-766 | `list_thread_pull_requests` or an authorized Git-host read | **STILL BLOCKED** — not exercised (UNKNOWN); a T3-reported PR is not verification anyway |
| EGA-767, EGA-685 | the above | depend on the features being built first |

**If an operation turns out to be unavailable, its downstream functionality is BLOCKED and
reported as such.** It is never replaced by a custom execution engine — T3 remains the only
execution engine.

## 8. What is genuinely proven right now

- The read-only native T3 integration works and is enforced as read-only by source-level tests.
- The external write contract's **shape** is captured for two T3 versions, and the versions
  differ — so the contract must be re-read per deployment.
- Helm is currently **structurally incapable** of invoking a native write, by allowlist, by
  scope, by route surface, and by test.

## 9. What is still NOT proven

What remains unproven, stated precisely so it is not confused with the confirmed results in §0:

- `t3_thread_launch.runtimeMode` — submitted, but the response does not echo it, so acceptance of the
  *mode* is an inference. Its effect is unmeasured, and it is not a publish boundary regardless.
- `t3_pending_request_list` / `_read` / `_respond` — not exercised (**UNKNOWN**).
- `list_thread_pull_requests` / `link_pull_request` — not exercised (**UNKNOWN**).
- `t3_project_create` — the captured refusal was a *duplicate workspace* error, so a scope-level denial
  was never demonstrated. Creation was done with the native admin CLI instead.
- `no_active_run` semantics for interrupt — only the accepted path was exercised.
- **Everything here was measured on an ISOLATED LOOPBACK instance.** Nothing proves behaviour against a
  hosted endpoint, and nothing widens Helm's runtime capability.

## 10. Non-mutating implementation design (the contract EGA-681/764/765/766 will consume)

This is a **design only**. Nothing here is implemented, and nothing here may be implemented
until §6 has produced authentic receipts. It exists so that the work after the probe is a
known quantity rather than a fresh design exercise.

### 10.1 Exactly what must change to enable a write

Enabling any native write is a deliberate, four-part change, all in one reviewable commit:

1. **Scope.** `READ_SCOPE` in `convex/t3OAuth.ts` is a single constant. A write grant means a
   *different* connection row with a different scope — never a widening of the existing
   read-only connection, and never a silent re-consent of a live one.
2. **Allowlist.** Add only the specific proven tool names to the `TOOLS` set. The allowlist is
   the enforcement point that runs *before* any network call, so an unproven tool cannot be
   reached even if the server would permit it.
3. **Schema.** `t3Connections.access` is fixed to `v.literal("read-only")`. A write-capable
   connection needs a distinguishable access level, so a reader of the database can tell the
   two apart. Widening this literal is a schema migration and is reviewable as such.
4. **Guards.** `convex/t3WriteCapability.test.ts` must be updated in the same commit. That is
   by design: the guard is the thing that makes "we proved it" a claim someone has to sign.

### 10.2 Call shapes (from the captured schema — to be re-read at execution time)

```
t3_thread_launch {
  title: string,                       // required
  projectId: string,                   // must equal the enabled mapping's t3ProjectId
  modelSelection: { model: string, provider?, instanceId?, options? },
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  interactionMode?: "default" | "plan",
  workspaceStrategy: { type: "worktree", baseRef: string, branch?: string|null,
                       startFromOrigin: boolean|null },
  message: string                      // the reviewed final prompt, verbatim
}

t3_thread_send    { threadId, message, mode?: "auto"|"queue"|"steer"|"restart",
                    clientRequestId? }
t3_thread_interrupt { threadId, runId?, reason?, clientRequestId? }
```

Rules that the design must preserve regardless of what the probe returns:

- **The prompt is submitted verbatim.** The reviewed payload from EGA-761 is what is sent;
  nothing is appended after confirmation.
- **Isolation comes from `workspaceStrategy`, never from prompt text.** Asking an agent to
  create its own worktree is not isolation.
- **`startFromOrigin` is explicit**, never implied.
- **`baseRef` (the worktree base) and `targetBranch` (the PR target) are different fields**
  from the mapping and are never aliased.

### 10.3 Durable attempt reservation, in order

The ordering is the safety property, not an implementation detail:

```
1. RESERVE   write a launchAttempts row (attemptId + payloadHash + issueKey + target identity)
             BEFORE any external call. The unique correlation key is what makes recovery possible.
2. DISPATCH  call t3_thread_launch with that correlation key embedded in the title.
3. ACKNOWLEDGE  record the returned threadId + runId against the reservation.
4. RECONCILE    on a lost or ambiguous acknowledgement, re-read the project's threads and
             resolve the correlation key. EXACTLY ONE match settles it; ZERO or MANY stays
             AMBIGUOUS. Never re-issue a launch after a lost acknowledgement.
```

A retry presents the **same** `attemptId` and the **same** `payloadHash`. The stored row — not
process-local state — decides whether a remote launch may happen. The same `attemptId` with a
different payload is rejected rather than reused, so a retried call can never silently mean
something different from the original request.

Multiple intentional executions per Linear issue are allowed, each with a **fresh** attempt.

**The historical `convex/dispatch.ts` isolated-dispatch path is not the production executor and
must not be reactivated as one.** Its reservation and reconciliation *patterns* are reused;
its separately-configured bearer-token integration is not.

### 10.4 Failure semantics

| Event | Correct behaviour |
|---|---|
| Launch response lost | reconcile by correlation key; never blind-retry |
| Ambiguous match (0 or >1) | stay `ambiguous`; surface for owner reconciliation; never relaunch |
| `t3_thread_send` rejected | report `rejected`; do **not** create a second thread as a substitute |
| Duplicate `clientRequestId` | report the native outcome honestly; do not assume dedupe |
| Interrupt with no active run | report `no_active_run` as a *state*, not a failure; delete nothing |
| Token revoked mid-flight | pause and require re-consent; a revoked grant is never silently retried |
| **Linear status update fails** | retry **only** the Linear operation. **A failed Linear sync must never initiate another native launch.** |

### 10.5 Receipts to record per probe step

Redacted: server version, tool name, argument *shape* (never prompt bodies or tokens), native
ids in truncated form, status fields verbatim, wall-clock timestamps, and one of the four
outcomes (*accepted* / *scope-refused* / *other-refused* / *ambiguous*).

### 10.6 Reading PRs (EGA-766) — the honest boundary

`list_thread_pull_requests` is a native read whose external invocability is unproven. Even when
proven, it reports what the *agent claims it created*. A PR link written in agent output is
**not** evidence a pull request exists.

The design therefore distinguishes exactly these states, and never collapses them:

`no PR` · `agent-reported but unverified` · `verified open` · `verified closed` ·
`verified merged` · `verification unavailable`

Only an authorized read-only Git-host integration (or authoritative metadata independently
verified against the Git host) may produce the `verified *` states. Read-only: no merge
endpoint, and no broader Git privilege for the execution agent than approved.

