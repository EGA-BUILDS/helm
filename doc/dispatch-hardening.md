# EGA-677 dispatch hardening — what changed and what was proven

Scope: make the dispatch path un-forgeable and make launch reconciliation real.
No real-remote push, merge or deployment. Isolated runtime and privileged
credentials unchanged.

---

## 1. Authorization: execution state is internal-only

Before, `launchAttempts` exported seven **public** functions and `credentials`
exported two public queries. Convex public functions are callable by anyone who can
reach the deployment URL, so any such client could have:

- forged a launch attempt,
- forged an acknowledgement and bound an attempt to a thread it did not create,
- reactivated a paused credential and resumed dispatch,
- launched arbitrary work through `dispatchIssue`,
- read credential and attempt state.

All of these are now `internalMutation` / `internalQuery` / `internalAction`, and
`dispatch.ts` calls `internal.*`.

**Resulting public surface: `health:check` and nothing else.**

### Verified against a live unauthenticated client

Raw HTTP POST to the deployment's Cloud endpoint, no `Authorization` header, no
credentials of any kind:

| Attempted call | Result |
|---|---|
| `launchAttempts:markAcknowledged` | refused |
| `launchAttempts:prepareLaunchAttempt` | refused |
| `launchAttempts:markDispatching` | refused |
| `launchAttempts:recordReconciliation` | refused |
| `launchAttempts:abandonAttempt` | refused |
| `credentials:recordCredential` | refused |
| `credentials:recordAuthSuccess` | refused |
| `credentials:recordAuthFailure` | refused |
| `dispatch:dispatchIssue` (arbitrary work) | refused |
| `credentials:canDispatch` | refused |
| `credentials:listCredentials` | refused |
| `launchAttempts:listAmbiguousAttempts` | refused |
| `launchAttempts:getCorrelationForReconciliation` | refused |
| `health:check` | **200 `{"status":"ok"}`** |

The `health:check` success is the control: it proves the probe was well-formed and
actually reaching the deployment, so the refusals are the boundary working rather
than a malformed request that would have failed anyway.

**State was not mutated.** `attacker-1` never appeared in `launchAttempts` (3 rows,
all pre-existing), and the credential row was unchanged. Forging is not merely
rejected at the edge — nothing lands.

The authorized path still works because the Convex CLI can invoke internal actions
directly; no public entry point was needed.

---

## 2. Reconciliation is now real, not a stub

Two defects made the previous "ambiguous" handling hollow:

1. **The correlation key was never in the thread title.** It was persisted in
   Convex and then used to title a thread as `Helm dispatch <issueKey>`. Nothing
   remotely searchable carried the key, so a lost acknowledgement could never be
   resolved — every one would have been a permanent human decision.
2. **Nothing ever searched.** Every ambiguous path passed a hardcoded
   `matchCount: 0`, meaning "ambiguous" was asserted by the code that created it
   rather than observed.

Now:

- The key is embedded in the launch title, so it is the one handle that survives a
  lost receipt.
- `findThreadsForCorrelation` searches `t3_thread_list` for threads carrying that
  exact key. Matching on the key rather than the issue number matters: an issue can
  legitimately have several threads over time, and a loose match could reconcile
  onto someone else's thread.
- `reconcileAttempt` (new) re-runs reconciliation against an **existing** attempt, so
  an operator can return later and ask "did this launch actually happen?". It has no
  relaunch path at all.

---

## 3. Verified behaviours

| Check | Result |
|---|---|
| Unauthenticated client cannot change execution state | **proven** — 13 paths refused, state verifiably unchanged |
| Authorized dispatch path still works | **proven** — dispatched, thread captured |
| Auth failure pauses subsequent dispatch | **proven** — credential `reauthorizationRequired`; next dispatch `paused`, `attemptId: null` |
| Ambiguous launch reconciles to the **existing** thread, no relaunch | **proven** — lost ack (launch really accepted, response discarded) → `reconciled` to the real thread, **no second launch** |
| Zero matches unresolved, never auto-relaunch | **proven** — `ambiguous`, `relaunchAuthorized: false` |
| Multiple matches unresolved, never auto-relaunch | **proven** — `ambiguous`; a later duplicate **demoted** an already-settled attempt |

Thread census after the run: exactly one thread per dispatched issue. The
auth-failure dispatch and the paused dispatch created **none**. The only 2× was a
duplicate I created deliberately to prove the many-match case.

### A caveat worth recording

When reconciliation demotes an attempt to `ambiguous`, the previously observed
`threadId` is **retained** while `state` becomes `ambiguous`. Consumers that gate on
`state` are safe. A consumer that read `threadId` alone could still follow a thread
that is no longer known to be the right one. Retaining it is defensible as evidence,
but it should be read only alongside `state`.

---

## 4. Regression guard

`convex/authz.test.ts` asserts the boundary from source, so a future
`export const x = mutation({` fails the build instead of quietly reopening the
deployment. It checks that execution-state modules contain no public function, that
`dispatch.ts` never reaches into the `api.*` namespace, that no path ever sets
`relaunchAuthorized: true`, that the only public function in the entire backend is
`health:check`, and that reconciliation refuses zero and many matches.

Each assertion was verified with a **negative control** — deliberately breaking the
property and confirming the test fails:

| Injected fault | Caught |
|---|---|
| Re-publicize one `launchAttempts` mutation | yes |
| Point dispatch at `api.launchAttempts.*` | yes |
| Add a second public query inside `health.ts` | yes |

The third control initially did **not** fail. The guard counted *files* containing a
public function, so a second public function appended to the already-allowed
`health.ts` passed. It now counts individual declarations. Worth flagging: the first
version of a security test was not actually testing the property it claimed to.

Checks: vitest 29/29, eslint clean, tsc clean.

---

## 5. Incident during this work

I ran `npx convex env list` intending to find the deployment URL. It prints every
environment variable, so the **privileged `T3_MCP_TOKEN`, the isolated token, and
`LINEAR_API_KEY` were written into this conversation transcript.** That is a real
credential exposure and it is my error, not a formatting artifact.

Containment done:

- Revoked every `mcp-client` session on the isolated instance.
- Re-issued the isolated credential through the pairing flow, stored it in
  Convex, and deleted all local copies.
- Re-verified: the new credential appears in **0** files under `/home/t3agent`.

**Still outstanding, needs the owner:**

| Credential | Action required |
|---|---|
| Privileged `T3_MCP_TOKEN` | rotate — I will not re-issue the owner's real credential |
| `LINEAR_API_KEY` | rotate in Linear |

The privileged credential was explicitly preserved by instruction, so revoking it is
the owner's call, not mine.

Separately, one "341 files leaked" reading was a false alarm of my own making: the
check ran from the wrong directory, `convex env get` failed, the search string was
empty, and `grep -F ""` matches every file. Re-run correctly it is 0, with a positive
control (a needle the agent does own does match) confirming the search works.

---

## 6. Unchanged

- Privileged `T3_MCP_URL` / `T3_MCP_TOKEN` untouched.
- Isolated runtime untouched: `t3agent` service, the `t3agent-stack` install, and
  the per-uid nft rules were not modified by this work.
- No real-remote push, merge or deployment.