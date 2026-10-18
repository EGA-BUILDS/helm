# EGA-758 — external-OAuth native T3 write capability matrix

**Status: preparation complete, live proof NOT STARTED.**

Machine-readable companion: [`ega-758-write-capability-matrix.json`](./ega-758-write-capability-matrix.json).

> ## HARD STOP
> **No write operation has been invoked, and none may be invoked, without separate explicit
> owner approval** naming: the disposable DEV T3 target, the exact OAuth scope to request,
> the repository/project to use, the possible Git writes the native agent may perform, and
> any cost or side effects.
>
> **The owner's authorization to merge PRs #8–#13 is NOT authorization for this probe.**
> Those are different operations with different blast radius.

---

## 1. Why this issue is a gate, not a feature

Helm's native T3 integration today is **read-only**: `convex/t3OAuth.ts` requests exactly
`orchestration:read` and allows exactly six tools. The v0.2 product needs native
**launch, follow-up and interrupt**. Whether Helm's *outside-OAuth* connection is permitted
to invoke those tools is **unproven**.

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

### 2.2 Write operations — UNKNOWN (9)

Exact field contracts below are from the committed sanitized capture
`doc/fixtures/t3-mcp-tools.schemas.json` (T3 `0.0.46-nightly.20261009.2873`) and a fresh
observation of the provider-session surface (T3 `0.1.1-nightly.20261018.3285`). **A captured
schema is a claim about a specific version, not a permission.**

| Operation | Contract captured | Required by | Verdict |
|---|---|---|---|
| `t3_thread_launch` | `required: [title]`; `projectId`, `scratch`, `modelSelection`, `runtimeMode`, `interactionMode`, `workspaceStrategy`, `message`, `attachments` | EGA-681, EGA-762 | **UNKNOWN** |
| `t3_thread_launch.workspaceStrategy` | `root` \| `existing_worktree{worktreePath,branch?}` \| `worktree{baseRef,branch?,startFromOrigin?}` | EGA-681 | **UNKNOWN** |
| `t3_thread_launch.modelSelection` | `{provider?,instanceId?,model(required),options?}` | EGA-761, EGA-681 | **UNKNOWN** |
| `t3_thread_launch.runtimeMode` | `approval-required` \| `auto-accept-edits` \| `auto` \| `full-access` | EGA-681, EGA-766 | **UNKNOWN** |
| `t3_thread_send` | `{threadId, message, mode?: auto\|queue\|steer\|restart, clientRequestId?}` | EGA-764 | **UNKNOWN** |
| `t3_thread_send.idempotency` | `clientRequestId` documented as idempotency key | EGA-764 | **UNKNOWN** |
| `t3_thread_interrupt` | `{threadId, runId?, reason?, clientRequestId?}` | EGA-765 | **UNKNOWN** |
| `t3_pending_request_respond` | approval/answer a pending request | EGA-765 | **UNKNOWN** |
| `link_pull_request` | `{threadId?, url?, repository?, number?, host?}` — and **not** independent proof a PR exists | EGA-766 | **UNKNOWN** |

### 2.3 Reads that are also unproven (3)

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
- the capability matrix cannot mark a write operation `CONFIRMED`, or attach a `proof`, while
  the guards hold.

That last assertion is deliberate: proving write capability requires editing a test in the
same commit as the change. Enabling a native write becomes a **reviewable act**, never a
side effect of some other refactor.

## 6. The probe (not executed — owner authorization required)

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

Every downstream feature that depends on an unproven operation. These are **BLOCKED**, not
"pending polish", and none of them may be emulated with a substitute engine.

| Issue | Depends on | Blocked because |
|---|---|---|
| EGA-681 | `t3_thread_launch` + workspace strategy | a launch cannot be implemented against an unproven contract |
| EGA-762 | accepted launch receipt | linking needs a real run to link |
| EGA-764 | `t3_thread_send` (+ idempotency) | follow-up semantics and duplicate behaviour are unverified |
| EGA-765 | `t3_thread_interrupt` (+ `no_active_run`) | interruption semantics are unverified |
| EGA-766 | `list_thread_pull_requests` or an authorized Git-host read | a T3-reported PR link is not verification |
| EGA-767, EGA-685 | the above | cross-system certification needs the features to exist |

**If an operation turns out to be unavailable, its downstream functionality is BLOCKED and
reported as such.** It is never replaced by a custom execution engine — T3 remains the only
execution engine.

## 8. What is genuinely proven right now

- The read-only native T3 integration works and is enforced as read-only by source-level tests.
- The external write contract's **shape** is captured for two T3 versions, and the versions
  differ — so the contract must be re-read per deployment.
- Helm is currently **structurally incapable** of invoking a native write, by allowlist, by
  scope, by route surface, and by test.

## 9. What is NOT proven

Everything in §2.2 and §2.3: 9 write operations and 3 unverified reads. No DEV thread has been
launched. No follow-up has been sent. No run has been interrupted. No PR metadata has been
read through the external grant.
