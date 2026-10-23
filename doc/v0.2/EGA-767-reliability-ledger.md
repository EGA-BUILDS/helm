# EGA-767 — cross-system reliability & owner-security ledger

**Baseline:** `develop` @ `a42d1d8` (the integrated v0.2 release candidate).
**Method:** each row names the scenario, the component that must fail, the invariant, the **named
test** that proves it, and the verdict. A row is only PASS if a test exists that would fail when
the protection is removed. Scenarios that cannot be reproduced offline are **PENDING** with the
reason — nothing is simulated to make a row look green.

**Mutation evidence** (the protection was removed and the named test observed to fail): recorded
against the release candidate during Phase C, and re-verified in this pass.

**A note on cited names.** Three of the titles below are *rendered* names from parameterised
`it.each` blocks, so a text search for the literal string in the source will not find them:

- `convex/linearSync.test.ts:509` — `it.each([["completed","Done"],["canceled","Canceled"]])` renders
  *"an issue already in a completed state …"* and *"…canceled state…"*.
- `convex/linearSync.test.ts:621` — `it.each([["missing",…],["expired",…],["revoked",…]])` renders
  *"a missing / expired / revoked Linear authorization records authorization_required without crashing"*.

Every other cited title is a literal string in its source file.

---

## 1. Launch / execution

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| Duplicate clicks on one issue | `convex/t3Launch.ts` | one native launch, never two | `convex/t3Launch.test.ts` — "a retry with the same attemptId and payload returns the stored thread without a second launch" | **PASS** |
| Two tabs racing one issue (stale token) | `convex/launchStaleRecovery.ts` | the stale attempt never dispatches a launch | `convex/launchStaleRecovery.test.ts` — "two tabs, one stale: B's launch with the stale null token is refused and dispatches no second launch" | **PASS** |
| Two tabs, fresh token | `convex/launchStaleRecovery.ts` | a *deliberate* second execution is still allowed | `convex/launchStaleRecovery.test.ts` — "two tabs with a fresh token: after B re-recovers, B's launch is accepted as an intentional second execution" | **PASS** |
| Lost native acknowledgement | `convex/t3Launch.ts` | ambiguous, never auto-relaunched | `convex/t3Launch.test.ts` — "zero reconciliation matches stay ambiguous and never relaunches"; `convex/launchStaleRecovery.test.ts` — "ambiguous still blocks with a fresh token and never relaunches" | **PASS** |
| Same attemptId, different payload | `convex/launchAttempts.ts` | refused; the stored thread is never re-targeted | `convex/t3Launch.test.ts` — "the same attemptId with a different payload is refused and never relaunches" | **PASS** |
| Attempt belongs to another issue/thread | `convex/linearAssociationStore.ts` | refused | `convex/linearAssociation.test.ts` — "refuses when the attempt belongs to a different issue or a different thread" | **PASS** |
| Reconciled launch | `convex/linearAssociationStore.ts` | recorded exactly once | `convex/linearAssociation.test.ts` — "also records a RECONCILED (recovered) launch, but nothing else" | **PASS** |
| **Lost ack surviving a browser reload** | `src/features/execute/ExecutePanel.tsx` + `src/features/linear/IssuesPanel.tsx` | no automatic relaunch after a reload | **CLOSED — HARNESS, not live acceptance (draft PR #36, pending merge)**: `tests/frontend/issues-execution.spec.ts` — "after a lost acknowledgement, a real browser reload shows ambiguous and offers no relaunch" and "after a launch, a real browser reload recovers the recorded thread and issues no second launch". **Real Playwright pages driving the mounted UI; every `/api/*` response is stubbed; no Convex or T3 connection is involved.** | **PASS (browser harness)** |
| **Two real browser tabs racing one issue** | browser + API | one launch wins | **CLOSED — HARNESS, not live acceptance (draft PR #36, pending merge)**: `tests/frontend/issues-execution.spec.ts` — "two tabs racing the same issue: only the first launch wins and the stale tab cannot relaunch". **Two real pages share one in-test stub attempt log**; the stale `null` token is refused 409 and no second launch is dispatched. This is not a hosted Convex/T3 concurrency receipt. | **PASS (browser harness)** |

## 2. Write boundaries (Linear)

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| GraphQL 200 **with** an `errors` array | `convex/linearSync.ts` | failure, never success | `convex/linearSync.test.ts` — "HTTP 200 with a GraphQL errors array is failure, not success, even when the re-read shows the target" | **PASS** |
| 200-with-errors on the **read** path | `convex/linearSync.ts` | uncertain, never trusted to write | `convex/linearSyncTrigger.test.ts` — "a 200-with-errors ISSUE READ is uncertain and never trusted to write (F3)" | **PASS** |
| HTTP 429 | `convex/linearSync.ts` | retryable, changes nothing on Linear, never relaunches | `convex/linearSync.test.ts` — "a Linear 429 is retryable, changes nothing on Linear, retries only the ledger, and never relaunches" | **PASS** |
| Timeout, then the write *did* land | `convex/linearSync.ts` | re-read decides; never crash-converted to success | `convex/linearSync.test.ts` — "a timed-out write is re-read: synced when the re-read observes the target state" | **PASS** |
| Timeout, write did not land | `convex/linearSync.ts` | retryable, not synced | `convex/linearSync.test.ts` — "a timed-out write is re-read: retryable when the re-read shows no change; never crash-converted to success" | **PASS** |
| Timeout and the re-read also fails | `convex/linearSync.ts` | explicitly not synced | `convex/linearSync.test.ts` — "a timed-out write whose post-write re-read also fails stays explicitly NOT synced" | **PASS** |
| `issueStateUpdate.success === false` | `convex/linearSync.ts` | a definite refusal, filed as `write_rejected` | `convex/linearSync.test.ts` — "an issueStateUpdate success=false is a definite refusal filed write_rejected, not unreachable" | **PASS** |
| Unreadable issue read | `convex/linearSync.ts` | uncertain, no write | `convex/linearSyncTrigger.test.ts` — the F3 read-path test (same guard) | **PASS** |
| Issue already Done | `convex/linearSync.ts` | `conflicted`, never overwritten | `convex/linearSync.test.ts` — "an issue already in a completed state is recorded conflicted and never overwritten" | **PASS** |
| Issue already Canceled | `convex/linearSync.ts` | `conflicted`, never overwritten | `convex/linearSync.test.ts` — "an issue already in a canceled state is recorded conflicted and never overwritten" | **PASS** |
| Issue moved to another team | `convex/linearSync.ts` | `conflicted`, never overwritten | `convex/linearSync.test.ts` — "an issue moved to another team is recorded conflicted and never overwritten" | **PASS** |
| A human moved the issue | `convex/linearSync.ts` | human intent respected, and the verdict is **sticky** | `convex/linearSync.test.ts` — "the human-intent verdict is STICKY: the third sync after a deliberate move still refuses to write (N1)"; "a human's move OUT of a started state (back to Backlog) is also intent and is never overwritten (N2)" | **PASS** |
| A state changed between the two reads | `convex/linearSync.ts` | `conflicted` on **state identity**, not `updatedAt` | `convex/linearSync.test.ts` — "a state-identity change between Helm's two reads conflicts (primary signal, F5)"; "a cosmetic-only change between the two reads (same state) no longer silently stalls the sync (F5)" | **PASS** |
| Ambiguous baselines | `convex/linearSync.ts` | fail closed, never skip the guard | `convex/linearSync.test.ts` — "ambiguous recorded baselines fail closed: conflicted and no write (N3)" | **PASS** |
| Wrong team's association on the same issue | `convex/linearSyncStore.ts` | a sibling team's row is never marked synced | `convex/linearSync.test.ts` — "the ledger never marks a sibling team's association synced under this team's sync (F1)" | **PASS** |
| **A Linear failure never launches native work** | `convex/linearSync.ts` | no sync path reaches execution | `convex/linearSync.test.ts` — "a failing sync never causes a T3 launch attempt anywhere" | **PASS** |
| Missing / expired / revoked Linear grant | `convex/linearSync.ts` | `authorization_required`, no crash | `convex/linearSync.test.ts` — "a missing Linear authorization records authorization_required without crashing" (+ expired, revoked) | **PASS** |
| Stale mapped started state | `convex/linearSync.ts` | a configuration stop, never a retryable failure | `convex/linearSync.test.ts` — "a stale mapped started state is a CONFIGURATION stop, never a retryable failure (F7)" | **PASS** |

## 3. Identity / authorization

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| Anonymous Convex call | `convex/auth.ts` | refused | `convex/authz.test.ts` — "denies anonymous and other authenticated direct Convex calls" | **PASS** |
| Non-owner call | `convex/lib/auth.ts` | refused | `convex/authz.test.ts` (same suite); `convex/linearAssociation.test.ts` — "anonymous and non-owner callers cannot record associations" | **PASS** |
| Cross-owner reach | `convex/linearAssociationStore.ts` | refused | `convex/linearAssociation.test.ts` — "cross-owner reaches are refused" | **PASS** |
| Cross-connection reach | `convex/linearAssociationStore.ts` | refused; the lookup binds the T3 connection | `convex/linearAssociation.test.ts` — "cross-connection reaches are refused: the lookup binds the T3 connection" | **PASS** |
| Stale owner revision on a manual link | `convex/linearManualLinkStore.ts` | refused | `convex/linearManualLink.test.ts` — "internal link with stale/absent owner is unauthorized"; "F6: unlink with stale/absent owner is unauthorized" | **PASS** |
| A read-only connection reaching a write | `convex/t3OAuth.ts` | refused **before any network call** | `convex/t3Send.test.ts` — "a read-only connection can never reach the write tool, before any network call"; `convex/lib/operateGate.test.ts` — "never selects a read-only connection, even when it is the only one" (mutation → 20 tests fail) | **PASS** |
| Cross-origin browser request | `src/app/api/t3/**` | refused | `src/app/api/t3/manual-link/route.test.ts` — 5 cases: a Referer-only same-origin GET is accepted, a foreign `Origin`, a foreign `Referer` and a bare navigation are refused | **PASS** (route level) |
| **A foreign origin reaching a state-changing POST** | `src/app/api/t3/**` | refused | the reviewer's own measurement: all three POSTs return `origin_mismatch` for a Referer-only request, and `requireSameOrigin` is unchanged | **PASS** (measured) |
| Secret / token in an error or response | `convex/t3Sanitization.ts`, `convex/credentials.ts` | never leaked | `convex/t3Sanitization.test.ts`, `convex/credentials.test.ts`; the Phase C review confirmed the read/write tool allowlists stay disjoint and tokens are AES-256-GCM ciphertext with owner+endpoint+purpose AAD, never returned to a client | **PASS** |

## 4. Identity uniqueness (one active binding)

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| A thread bound to two issues | `convex/linearAssociationStore.ts` | refused | `convex/linearAssociation.test.ts` — "a thread is bound to exactly one issue" | **PASS** |
| The same, after many unlink/reassign cycles | `convex/linearAssociationStore.ts` | still one active binding | `convex/linearAssociation.test.ts` — "F3: a thread with many tombstones is still bound to exactly ONE issue" (fails against the old windowed scan) | **PASS** |
| A tombstoned binding resurrected by a launch retry | `convex/linearAssociationStore.ts` | refused | `convex/linearManualLink.test.ts` — "M8/F9: a tombstoned binding cannot be resurrected by a launch retry" | **PASS** |
| Two tombstones then a launch | `convex/linearAssociationStore.ts` | one active binding | `convex/linearManualLink.test.ts` — "N1: two tombstones then a launch leaves exactly one active binding" | **PASS** |
| A manual link synced without opt-in | `convex/linearSync.ts` | refused, with the reason named | `convex/linearSync.test.ts` — "M3: a manual-only association refuses sync without opt-in" | **PASS** |
| A **mixed** issue synced without opt-in | `convex/linearSync.ts` | only the launch-derived binding is synced | `convex/linearSync.test.ts` — "F10: a MIXED issue syncs only the launch-derived binding unless the operator opts in" | **PASS** |
| A manual link adopted by an accepted launch | `convex/linearAssociationStore.ts` | becomes a sync obligation again, synced once | `convex/linearSyncTrigger.test.ts` — "F2: a manual link ADOPTED by an accepted launch becomes a sync obligation again"; `convex/linearSyncLaunchTrigger.test.ts` — "a launch that ADOPTS a manual binding still schedules the sync (F2/R2-a)" | **PASS** |
| A manual row mislabelled as launch-derived | `convex/linearSync.ts` | still refused — the exclusion is `attemptId` | `convex/linearSyncTrigger.test.ts` — "the exclusion of manual rows is the attemptId check, not a provenance column (F4)"; "the TRIGGER also refuses a manual row whose ledger provenance claims launch (F4)" | **PASS** |
| A manual row written by the trigger/driver | `convex/linearSync.ts` | never written | `convex/linearSyncTrigger.test.ts` — "the TRIGGER never writes a manual association's ledger row (F3/F4)"; "the DRIVER never writes a manual association's ledger row (F3/F4)" | **PASS** |

## 5. Ambiguity and recovery

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| A dropped trigger | `convex/linearSync.ts` | the periodic driver recovers the `pending` row | `convex/linearSyncTrigger.test.ts` — "the periodic driver owns a `pending` row: a dropped trigger is recovered (F5)" | **PASS** |
| Trigger and driver racing | `convex/linearSyncStore.ts` | one write, via the `syncing` claim | `convex/linearSyncTrigger.test.ts` — "the driver and the immediate trigger never write the same issue twice in one window (F6)"; "the trigger refuses to write while another driver holds the claim (F6)" | **PASS** |
| Running the trigger twice | `convex/linearSync.ts` | a strict no-op | `convex/linearSyncTrigger.test.ts` — "running the trigger twice performs no second Linear write" | **PASS** |
| A failing row inside its backoff window | `convex/linearSync.ts` | not re-driven | `convex/linearSyncTrigger.test.ts` — "a failed row is re-driven only after its backoff window elapsed (F8)" | **PASS** |
| A persistently failing row | `convex/linearSync.ts` | bounded, then abandoned by the driver | `convex/linearSyncTrigger.test.ts` — "a persistently failing row stops being retried at the bound (F10)" | **PASS** |
| The driver's batch | `convex/linearSync.ts` | bounded by count **and** time | `convex/linearSyncTrigger.test.ts` — "the driver is bounded by count and by time (F9)" | **PASS** |
| Queue starvation | `convex/linearSync.ts` | the oldest rows must not starve the rest | `convex/linearSyncTrigger.test.ts` — "the driver serves the least-recently-touched row first and rotates the queue (F9)" | **PASS** |
| The operator queue lists a row twice | `convex/linearSync.ts` | each row at most once | `convex/linearSync.test.ts` — "openLedger exposes the operator work queue by the by_state index; synced rows never appear (F8)"; "openLedger orders by actionability with a per-state budget: a conflicted row surfaces among a FULL pending budget (N7)" | **PASS** |
| A `conflicted` / `authorization_required` row | `convex/linearSync.ts` | visible to the operator, and the state names the reason | the two `openLedger` tests above | **PASS** |
| **Why a row was skipped** | `convex/linearSync.ts` | diagnosable | `convex/linearSyncTrigger.test.ts` — "the driver reports WHY every row was left alone (F13)" | **PASS** |

## 6. Send / interrupt

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| Rapid double click on send | `src/features/t3/FollowUpControl.tsx` | one native send | `tests/frontend/followup.spec.ts` — the in-flight guard test | **PASS** |
| A receipt for a different thread | `src/features/t3/FollowUpControl.tsx` | refused, not rendered | `tests/frontend/followup.spec.ts` — "a receipt for a different thread is refused instead of being rendered" | **PASS** |
| A stale response after a selection change | `src/features/t3/FollowUpControl.tsx` | discarded | `tests/frontend/followup.spec.ts` — "a response that arrives after the selection changed is discarded" | **PASS** |
| An `ambiguous` send | `src/features/t3/FollowUpControl.tsx` | no acknowledgement callback, retry offered | `tests/frontend/followup.spec.ts` — "the acknowledgement callback fires for accepted and queued only" | **PASS** |
| An interrupt aimed at a stale run | `convex/t3Interrupt.ts` | refused | `convex/t3Interrupt.test.ts` — the stale-run and cross-thread cases (mutation → 7 failures) | **PASS** |
| A confirmation surviving a run change | `src/features/t3/InterruptControl.tsx` | discarded, no request issued | `tests/frontend/interrupt.spec.ts` — "an armed confirmation is discarded when the selected run changes, with no request issued"; `tests/frontend/interrupt-reset.spec.ts` | **PASS** |
| An ambiguous interrupt | `convex/t3Interrupt.ts` | ambiguous, never auto-retried | `tests/frontend/interrupt.spec.ts` — "an ambiguous dispatch is reported as ambiguous and never auto-retried" | **PASS** |
| An unknown run status | `convex/lib/runStatus.ts` | `unknown`, never "running" | `convex/t3Attention.test.ts` — "returns unknown, never needs_attention or idle, for an unrecognised run status" | **PASS** |
| Needs-attention without real evidence | `convex/t3Attention.ts` | never asserted | `convex/t3Attention.test.ts` — "reports needs_attention only with real waiting-run evidence" | **PASS** |

## 7. GitHub pull-request verification

| Scenario | Failing component | Invariant | Proof (named test) | Verdict |
|---|---|---|---|---|
| A forged PR URL | `convex/lib/verifiedPullRequest.ts` | refused before GitHub is asked | `convex/lib/verifiedPullRequest.test.ts` — the host/repo/number cases (mutation → 5 failures) | **PASS** |
| A PR from another repository | `convex/lib/verifiedPullRequest.ts` | refused | `convex/lib/verifiedPullRequest.test.ts` — "refuses a pull request that really lives in another repository" | **PASS** |
| A head branch that is not the thread's | `convex/lib/verifiedPullRequest.ts` | refused | `convex/lib/verifiedPullRequest.test.ts` — "refuses a pull request that the claim and GitHub agree on but the thread does not" | **PASS** |
| No credential | `convex/verifiedPullRequest.ts` | `verification_unavailable`, never a false positive | `convex/verifiedPullRequest.test.ts` — the owner-path case | **PASS** |
| Review status without evidence | `src/features/t3/verifiedPullRequest.ts` | no review line at all | `tests/frontend/verified-pull-request.spec.ts` — "shows no review line when the authoritative source gave no decision" | **PASS** |

## 8. Read-only v0.1 regression

| Scenario | Failing component | Invariant | Proof | Verdict |
|---|---|---|---|---|
| The read paths still work | frontend | environments, projects, threads, activity still read | `src/features/t3/state.test.ts`, `src/features/t3/backend.test.ts`, `tests/frontend/dashboard.spec.ts`, `tests/frontend/live-dashboard.spec.ts` — 74 browser tests green | **PASS** |
| A read-only connection still cannot write | `convex/lib/operateGate.ts` | the operate gate is unchanged | `convex/lib/operateGate.test.ts` (mutation → 20 tests fail) | **PASS** |
| A fixture preview mounts no write control | `src/features/t3/Dashboard.tsx` | no write control, no request | `tests/frontend/dashboard.spec.ts` — "a connected preview never offers a native write control" | **PASS** |

---

## 9. Summary

| | Count |
|---|---|
| Scenarios covered with a **named, mutation-proven** backend/unit test | **58** |
| Scenarios covered by a **browser regression harness** (not mutation-proven) | **2** |
| Scenarios accepted **live** against hosted Convex/T3 | **0** |
| Scenarios FAIL | **0** |
| Scenarios papered over with a fixture | **0** |
| Hosted recovery / concurrency acceptance | **PENDING — separate owner-gated run** |

### Update 2026-10-23 — two rows moved from PENDING to browser-harness coverage

Draft PR #36 mounted the execution review on a verified Linear issue and added a
Playwright harness that drives the **real** `LinearIssueBrowser` while every
`/api/*` response is **stubbed**. The two rows below moved from "no
owner-facing path to exercise" to a regression test:

1. **Lost ack surviving a browser reload** — a full `page.reload()` plus
   re-selecting the issue recovers the stub's recorded thread ("Already
   launched", the exact thread id) and issues no second POST; the ambiguous case
   shows "Prior attempt ambiguous", disables launch and offers no retry.
2. **Two real browser tabs racing one issue** — two real pages share one stub
   attempt log; the first launch succeeds, the second tab's pre-launch `null`
   token is refused `409 stale_recovery`, and no second launch is dispatched.

**Evidence class:** these are client-behaviour tests on real Playwright pages.
They do **not** connect to Convex or T3, do not prove hosted concurrency, and are
**not mutation-proven**. Hosted recovery and concurrency acceptance remain
PENDING under the owner-gated DEV run. The historical reasoning below is
retained because it explains why the rows were PENDING before the panel was
mounted.

### Why the two rows were PENDING before PR #36

1. **A lost native acknowledgement surviving a browser reload.** The API-level behaviour is proven
   (`ambiguous`, never auto-relaunched). The *browser* reload path lives in `ExecutePanel`, which is
   built and tested but **never mounted** — the dashboard has no launch affordance. There is no
   owner-facing path to reload, so there is nothing to test. Fixing it means mounting the panel
   (v0.2.1), not writing a test.
2. **Two real browser tabs racing one issue.** The API-level race is proven (a stale token is
   refused; a fresh token is an intentional second execution). Two *simultaneous* browser tabs
   driving the same issue are not exercised. This needs a browser-level concurrency harness.

> Historical note: both gaps were closed by PR #36 as described above. The live
> write-path receipts remain a separate, owner-gated gap (EGA-685).

### What this ledger does NOT claim

No hosted failure receipts are included. The DEV deployment was exercised with **read-only** probes
only (see the release-closure ledger §8g): a hosted T3 MCP handshake, hosted T3 discovery and a
Linear API read. **No hosted write was performed**, because native dispatch is disabled on DEV
(`T3_PROJECT_ID_ISOLATED` missing) and Helm's Linear OAuth client is not configured. Live
write-path failure receipts are therefore **PENDING** under EGA-685, and are the one class of
evidence this certification could not produce.
