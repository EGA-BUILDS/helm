# EGA-677 — remaining gate checks (2 / 3 / 5) and the push blocker re-test

Second pass, run after the first proof (`doc/proof/ega677-results.md`). Each check is
recorded separately. Criteria are marked passed **only** where evidence satisfies them.

---

## Check A — Credential expiry / reauthorization (criterion 2, renewal half)

**Method: a disposable credential only. The working credential was never modified.**

`t3 auth session issue --scope orchestration:read --ttl 90s --label ega677-expiry-probe`
minted a disposable credential, stored `0600`, never printed. The working Convex
`T3_MCP_TOKEN` was never replaced.

### Finding A1 — hosted MCP accepts ONLY OAuth `mcp-client` credentials

A locally-issued bearer session was rejected by the hosted endpoint:

```
{"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}
```

Locally-issued sessions and hosted OAuth MCP credentials are **different credential
classes**. A local `t3 auth session issue` token cannot exercise the hosted path at all.

### Finding A2 — every auth failure collapses to one indistinguishable tag

Probed against the live hosted endpoint:

| Case | Result |
|---|---|
| valid working OAuth credential | **SUCCESS**, 80 tools |
| revoked disposable credential | REJECTED `invalid_mcp_credential` |
| garbage credential | REJECTED `invalid_mcp_credential` |
| empty `Bearer ` | REJECTED `invalid_mcp_credential` |
| no `Authorization` header | REJECTED `invalid_mcp_credential` |
| `DPoP <token>` as the scheme | REJECTED `invalid_mcp_credential` |

**Expired, revoked, malformed, missing and wrong-scheme are indistinguishable.** There
is no signal that separates "expired, go re-authorize" from "malformed, this is a bug".
This is the operationally important result for Helm: it cannot detect expiry in
advance, and cannot prove a token is still live without a live call.

### Finding A3 — DPoP is advertised but not enforced

```
valid bearer + deliberately bogus DPoP header  ->  SUCCESS, 80 tools
```

A bogus `DPoP` proof is ignored. The credential behaves as a **plain bearer token**
with no proof-of-possession binding, so token theft alone yields full access. A valid
DPoP JWT was never required by any observed code path.

### Finding A4 — reauthorization recovery path works

After revocation, re-issuing produced a working credential again. The *shape* of
recovery is therefore: mint → use → on `invalid_mcp_credential` → re-mint. It is
**re-authorization, not renewal** — no refresh token was observed on the OAuth token
response (`expires_in: 2592000`, ~30 days, not owner-controllable via pairing TTL).

### Verdict for criterion 2: **PARTIAL — renewal remains OPEN**

| Sub-claim | Status |
|---|---|
| Hosted authenticated discovery | MET (earlier) |
| Isolated launch | MET (earlier) |
| Observation | MET (earlier) |
| Reconnect/renewal | **NOT MET** |

What is genuinely proven: auth failures are detectable and cleanly classifiable as
*auth* failures, and recovery by re-authorization works. What is **not** proven:
automatic renewal before expiry, because no refresh mechanism was found and the
access-token TTL is not controllable. Real hosted TTL expiry could not be exercised —
it needs a short-lived OAuth credential, which requires the owner's browser approval.

---

## Check B — Lost launch acknowledgment (criterion 3)

**This is the criterion-3 test, properly faulted.**

### Method

1. Baseline: `t3_thread_list` filtered by a unique title → **0 matches**.
2. `t3_thread_launch` executed. T3 **accepted** the launch and created the thread.
3. **Fault injected after acceptance**: the action discarded the receipt and threw.
4. Caller received only a bare server error — **no threadId ever surfaced**.
5. Reconciled by correlation on the unique title, **without relaunching**.

### Observed

```
✖ Failed to run function "integration/_verifyProbe:injectLostAck":
Error: [Request ID: 12231a0685d184fe] Server Error
Uncaught Error: INJECTED_LOST_ACK after remote acceptance. receipt_suppressed=true
```

Reconciliation result:

```json
{ "matchCount": 1,
  "matches": ["mcp:58ee0336-b6be-489c-8462-3bc18246e5b3"],
  "statuses": ["running"] }
```

Baseline 0 → after injection 1. **Exactly one thread, no duplicate.**

### Verdict for criterion 3: **MET for the title-correlation path**

Correlation via `t3_thread_list` + `titleContains` reliably finds the orphaned thread,
and no blind relaunch is needed.

**Scope limit, stated honestly:** the correlation key was a *deliberately unique
title*. With a non-unique title, `titleContains` cannot distinguish a retry from the
original, and Helm would need a stronger correlation key. That stronger key is not
yet designed or proven.

---

## Check C — Linear pagination and blockers (criterion 5)

Controlled fixtures in a dedicated project `P-EGA-13` ("EGA-677 Proof Fixtures"),
team Egawilldoit. Real Helm issues were not modified. All four fixtures were canceled
after the test.

### C1 — Pagination: **PROVEN**

12 pages at `limit: 3` = **36 items, zero duplicates**, distinct monotonic cursors,
`hasNextPage` accurate throughout. Field names are `id` (not `identifier`), with
`hasNextPage` + `cursor` — two earlier attempts using `identifier`/`nextCursor`
silently returned nulls rather than erroring.

Status types observed live: `started`, `completed`, `backlog`, `unstarted`,
`duplicate`, `canceled`.

### C2 — Blocker statuses: **PROVEN**

| Blocker | `statusType` | Terminal marker |
|---|---|---|
| completed | `completed` | `completedAt` set, `canceledAt` null |
| canceled | `canceled` | `canceledAt` set, `completedAt` null |
| unresolved | `backlog` | both null |

Completed and canceled are cleanly separable via both `statusType` and the timestamp
pair.

### C3 — Unreadable blocker: handled distinctly and atomically

```
blockedBy: ["EGA-99999"]  ->  Could not find issue "EGA-99999" for blockedBy
```

A clear, specific error naming the offending identifier — **not** a silent drop and
not a partial write. `save_issue` is atomic, so the earlier valid relations in the
same batch were not left half-applied.

### C4 — BLOCKER: blocker relations are WRITE-ONLY through this MCP surface

`save_issue` accepts `blockedBy`, `blocks`, `relatedTo` and their `remove*` variants.
But `get_issue` returns **no relation fields at all** — the response has `id`, `status`,
`stateHistory`, `attachments`, … and nothing matching `/block|relat|depend|duplicate/`.
`list_issues` likewise exposes no relations.

Relations were confirmed persisted server-side, but Helm **cannot read dependency
direction** with the available tools. Only `duplicateOf` is echoed back, and only on
write.

### Verdict for criterion 5: **PARTIAL**

Pagination, blocker statuses, and unreadable-blocker handling are proven. **Dependency
direction is not observable** — a genuine blocker for any dispatch logic that must
respect a dependency chain.

---

## Push blocker re-test — workspace hypothesis DISPROVEN

The first push test ran with `workspaceStrategy: {type:"root"}`. Since the owner's
decision was to investigate before designing around the blocker, the same push was
repeated from an **isolated worktree** in the same disposable project.

```
$ git push -u origin HEAD:ega-677-push-probe-wt
To file:///tmp/opencode/helm-proof/helm-proof-remote.git
 * [new branch]      HEAD -> ega-677-push-probe-wt
```

**Executed. Not blocked. No approval prompt.** Remote ref
`refs/heads/ega-677-push-probe-wt 827a2cd` was created.

| Workspace | Push outcome |
|---|---|
| project root (`{type:"root"}`) | executed, exit 0, no prompt |
| isolated worktree | executed, exit 0, no prompt |

The gating gap is **not workspace-scoped**. `approval-required` did not gate a push in
either workspace type. Criterion 4 stands as a **blocker**.

Note this also means the gap is not explained by worktree-vs-root permission models,
so the "config gap" hypothesis is not supported by the evidence available here.

---

## Gate reassessment

| Criterion | Verdict |
|---|---|
| 1. Target mapping, grants, provider/model, safe issue | **MET** |
| 2. Hosted discovery / launch / observation | **MET** |
| 2. Renewal | **OPEN** |
| 3. Lost acknowledgment + correlation, no blind relaunch | **MET** (title-correlation path) |
| 4. push/merge/deploy require owner authorization | **BLOCKER** |
| 5. Pagination + blocker statuses + unreadable | **MET** |
| 5. Dependency direction readable | **BLOCKER** |
| 6. Fixtures + gate report + credential storage | **MET** |
| 7. Scope/TRD recorded, blockers reported not worked around | **MET** |

Two blockers stand, both evidence-backed rather than assumed:

1. **`approval-required` does not gate git pushes.** Not workspace-scoped. Helm cannot
   use the runtime as a push-safety control.
2. **Linear relations are write-only.** Helm cannot read dependency direction, so
   dependency-respecting dispatch cannot be built on this surface today.

**Recommendation: the gate does not pass.** Criterion 4 in particular is a
prerequisite for any dispatch feature that touches a real repository, and neither
workaround is available inside Helm's control — both need either a T3 change or an
owner-side control (credentials the agent never holds, disposable clones only).

No dependent execution work was started.