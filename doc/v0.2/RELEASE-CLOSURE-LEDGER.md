# HELM v0.2 — Release Closure Ledger

> ## Addendum — 2026-10-23
>
> This ledger's closure evidence is historical (through PR #34, `develop`
> `b85a8e3`). A later verification pass produced two code changes and a
> reconciled state document:
>
> | Item | Result |
> |---|---|
> | P0 native write destination | `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS`, required and fail-closed, enforced in launch/send/interrupt before any network call — draft PR #35, 755 backend tests |
> | P1 execution review | `ExecutePanel` mounted through the issue browser; superseded issue reads dropped; disabled "Start thread" replaced by a real route — draft PR #36 |
> | EGA-767 PENDING rows | both closed with mounted-interface browser tests (reload after lost ack; two-tab race) |
> | "Connection error: Unknown" | fixed: no current error / not reported / confirmed code are now distinct |
> | Docs | `README.md` rewritten; `CURRENT-STATE-20261023.md` added; this ledger and `OWNER-ACTIONS.md` carry dated current-state headers |
>
> Live DEV acceptance was **not** performed: it remains gated on Linear OAuth
> configuration/consent and on the owner approving a disposable write target.
> Production is untouched. Read `doc/v0.2/CURRENT-STATE-20261023.md` for the
> reconciled matrix.

Durable record for the v0.2 release-closure mission. Reconstructed from remote GitHub, Linear and
this file after any context loss. **No secrets, credentials or private prompt contents are stored
here.** Environment inspection is recorded by *variable name and presence only*.

---

## 1. Models and tooling

| Field | Value |
|---|---|
| Owner-approved main-agent model | `opencode-go/deepseek-v4.1-flash` (OpenCode Go) — verified `active` in the live catalog |
| Session model at closure time | `opencode-go/minimax-m3.1-flash-free` (the app selected it; the main agent cannot self-switch). Also an owner-approved free model. Recorded rather than hidden. |
| Subagent pool (owner-approved, free only) | `opencode-go/beam-free`, `opencode-go/minimax-m3.1-flash-free`, `opencode/beam-free`, `opencode/glm-5.3-flash-free` |
| EGA Skills MCP | **NOT AVAILABLE** — zero MCP servers registered, empty Linear agent-skill list. `preflight-repository`, `adversarial-review`, `certify-pr-head`, `integrate-pr-stack`, `review-and-ship`, `certify-release` could not be read or executed. The equivalent procedures are performed manually and are evidenced below. |

---

## 2. Phase A — reconstructed state

```text
develop  f67f607085a65144ef5b2870a1d09aef3446bb55
main     0e863c410cf5b0eba438d0e656794fce366880b6   (untouched)
```

All nine v0.2 PRs open, `MERGEABLE`, `mergeStateStatus=CLEAN`, CI green on their exact heads.

### Status matrix

| Bucket | Contents |
|---|---|
| **ALREADY DONE** | Shared operate gate (#20) · EGA-764 follow-up (#18) · EGA-765 interrupt (#19) · EGA-766 verification core (#24) · EGA-770 config validator + runbook (#22) · EGA-762 association + sync ledger (#25) · EGA-763 manual linking backend (#26) |
| **IMPLEMENTED BUT NOT INTEGRATED** | EGA-769 operate consent (#23) — code complete, **ancestry diverged** from the integration head; needs restack. Integration candidate (#21) — holds the shared Dashboard, merged write-route guard, `reloadActivity`, needs-attention badge and the verified-PR wiring |
| **INCOMPLETE** | **B3** EGA-762 has no *product* trigger — sync is operator-invoked only, nothing in the app drives it. **B4** EGA-763 has no Dashboard UI — backend actions exist but the owner cannot link from the app. **B5** the verified-PR component is wired locally at `2652bb5` but that head was never pushed, so PR #21 still shows `edd48da` |
| **BLOCKED BY OWNER** | Vercel DEV origin + Helm scope access · Clerk publishable/secret keys on the Vercel side · `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` / `LINEAR_OAUTH_ENCRYPTION_KEY_V1` · `GITHUB_TOKEN` · an owner-completed T3 **operate** consent · first Linear consent |
| **BLOCKED BY TECHNICAL DEFECT** | None outstanding. Every defect found in prior review rounds was repaired and mutation-proven; the two that survived (EGA-763 window, EGA-762 inertness) are fixed in the current heads |
| **DEFERABLE TO v0.2.1** | EGA-766 branch-level PR binding (needs T3 to expose a PR id or head SHA) · EGA-762 `retryable` scheduled driver (operator-initiated today) · EGA-770 `runtime:"next"` leak guard (no caller) · EGA-769 two-connection leakage test |

### Ancestry facts governing integration order

```text
f67f607 develop
  └─ df9c7b5  gate (#20)
       ├─ 6cde5b8  764 (#18)      3 commits
       ├─ 506e9f2  765 (#19)      3 commits
       └─ 9682ed7  integration: merge 765 repair
            └─ edd48da  integration: merge 764 round-2   ← PR #21 head on the remote
                 (local, UNPUSHED: f830fcc merge 766 → 2652bb5 verified-PR wiring)
```

- PR #23 (EGA-769) is based on `9682ed7`, which **predates** `edd48da`. Its own two commits touch
  only 769 files, so a merge keeps the 764 round-2 repairs — but the base must be reconciled.
- PR #18 and PR #19 both modified `convex/t3WriteCapability.test.ts`, each dropping the other's
  assertion. The **merged** guard exists only on the integration branch. Merging #18 and #19
  straight into `develop` would conflict on that file. The integration branch is the only place the
  conflict is already resolved — so **#21 is the only safe way to land 764+765 together.**
- #24, #25, #22 are based on `develop` directly and touch disjoint files (plus `convex/authz.test.ts`
  for #24/#25, which merges cleanly in sequence).

---

## 2b. Merge policy and CI provenance (verified)

### Repository ruleset — applies to `main` only

```text
ruleset 25153107  "Protect main"  target=branch  enforcement=active
conditions: ref_name.include = ["refs/heads/main"]   exclude = []
bypass_actors: []
```

- `main` requires: a pull request, `Application verification (Node 22/24)` and
  `Frontend browser verification` (strict policy), non-fast-forward, and no deletion.
- **`develop` is not protected** — `GET /branches/develop/protection` returns 404 and no ruleset
  includes it. Integration into `develop` therefore has **no enforced review or status-check gate**;
  the discipline is ours. The mission authorises conditional integration of the named PRs into
  `develop` once the mandatory gates pass, and explicitly not into `main`.
- Integration method: **merge via the GitHub PR merge API, one PR at a time**. No direct branch
  push, no force-push, no admin bypass. Merge commits (not squash/rebase) so ancestry stays visible.

### CI provenance — PR checks are synthetic merge-result checks

```yaml
on:
  push:
    branches: [main]
  pull_request:
jobs.verify.steps:
  - uses: actions/checkout@v4      # no `ref:` → default checkout
```

`actions/checkout@v4` without a `ref:` checks out the **merge commit** (`refs/pull/N/merge`) for a
`pull_request` event, and the `push` trigger fires **only for `main`**. Consequences:

1. A green PR check is a **merge-result** check, not an exact-head check. It is the right gate for
   merging, but it must never be reported as head certification.
2. **No exact-head CI exists for branch heads** in this repository. Exact-head certification is
   established by running the full gate suite locally against the head SHA, and by the independent
   review of that same SHA. Both are recorded per issue in §4.
3. `strict_required_status_checks_policy: true` on `main` means checks must be current with the head
   at merge time — so a push after a green run must be re-verified before merging to `main`.

---

## 3. Phase E — hosted DEV evidence (read-only inspection, names only)

### Convex DEV — **EXISTS and is reachable**

```text
Team helm · Project helm · Deployment hardy-warthog-60 · Type dev
```

Environment variables present on DEV (names only): `CLERK_FRONTEND_API_URL`, `HELM_APP_URL`,
`HELM_BASE_REF`, `HELM_OWNER_SUBJECT`, `HELM_REPOSITORY`, `LINEAR_API_KEY`, `LINEAR_PROJECT_ID`,
`T3_MCP_TOKEN`, `T3_MCP_TOKEN_ISOLATED`, `T3_MCP_URL`, `T3_MCP_URL_ISOLATED`,
`T3_OAUTH_ENCRYPTION_KEY_V1`.

Environment variables **absent** on DEV: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
`LINEAR_OAUTH_ENCRYPTION_KEY_V1`, `GITHUB_TOKEN`.

### DEV database state (counts and non-secret fields only)

| Table | State | Consequence |
|---|---|---|
| `ownerGrants` | **1 row** — issuer `https://climbing-pegasus-6180.clerk.accounts.dev` (Clerk **development** instance), revision 1 | The owner grant **already exists** on DEV. Owner sign-in is not the blocker it was assumed to be |
| `t3Connections` | **1 row** — `access: "read-only"`, `status: "connected"`, endpoint `https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp` | A live T3 connection exists but is **read-only** → launch/send/interrupt are all refused. This is exactly the gap EGA-769 closes |
| `linearConnections` | **0 rows** | Linear OAuth has never been completed in DEV |
| `linearProjectMappings` | **0 rows** | No mappings exist; EGA-685 steps 4–6 cannot run |

**Two observations that need owner awareness**

1. The only T3 connection in DEV points at the **production** T3 relay (`prod-…t3coderelay.com`).
   Requesting an `operate` grant against that endpoint is a **production-permission escalation**,
   which this mission does not authorize. A DEV operate grant should target an isolated T3 endpoint.
2. The Clerk **development** instance is live and granted, so the remaining Clerk gap is only the
   Vercel-side keys — not the instance itself.

### Vercel — **no stable DEV origin; scope not reachable**

- The Helm Vercel project `ega-builds/helm` exists and produces **Preview** deployments through the
  GitHub App integration (every PR shows `Vercel pass`).
- The local Vercel CLI is authenticated to an **unrelated scope** (`gym-track3`); `vercel ls --scope
  ega-builds` returns `Error: The specified scope does not exist`. The Helm project is therefore
  **not administrable** from this environment.
- There is no `vercel.json` and no configured `environments` block, so **no stable DEV origin exists**.
  A per-branch Preview is not a DEV origin and does not carry DEV environment variables.

### GitHub

- `GITHUB_TOKEN` is absent from DEV and from the local environment → EGA-766 verification returns
  `verification_unavailable` in DEV, which is the correct fail-closed behaviour, not a defect.

---

## 4. Per-issue ledger

| Issue | PR | Base → Head | Status | Review | CI | DEV evidence | Next action |
|---|---|---|---|---|---|---|---|
| gate | #20 | `f67f607` → `df9c7b5` | CODE_READY | mutation-proven ×2 | green | n/a | merge first |
| EGA-764 | #18 | `df9c7b5` → `6cde5b8` | CODE_READY | 2 rounds, 0 blocking | green | none (stubbed) | land via #21 |
| EGA-765 | #19 | `df9c7b5` → `506e9f2` | CODE_READY | 1 round + lead browser suite, 0 blocking | green | none (stubbed) | land via #21 |
| EGA-766 | #24 | `f67f607` → `61e0337` | CODE_READY | 2 rounds, 0 blocking | green | none — no `GITHUB_TOKEN` | merge independently |
| EGA-770 | #22 | `f67f607` → `e8cb876` | CODE_READY | 3 rounds, 0 blocking | green | validator is the DEV check | merge independently |
| EGA-762 | #25 | `f67f607` → `8a80f99` | CODE_READY | 3 rounds, 0 blocking | green | 0 Linear rows in DEV | **B3: add product trigger** |
| EGA-763 | #26 | `8a80f99` → `215b499` | CODE_READY | 4 rounds, 0 blocking | green | 0 Linear rows in DEV | **B4: add Dashboard UI** |
| EGA-769 | #23 | `9682ed7` → `93acd5b` | CODE_READY | 2 rounds, 0 blocking | green | 1 read-only T3 connection exists | **B2: restack onto new develop** |
| integration | #21 | `df9c7b5` → `edd48da` remote / `2652bb5` local | CODE_READY | lead-owned | green (remote head) | — | push `2652bb5`, then land |
| EGA-681 | — | — | merged earlier (#16) | — | — | launch exists, read-only blocks writes | needs operate consent |
| EGA-767 | — | — | not started | — | — | — | Phase F after integration |
| EGA-685 | — | — | not started | — | — | 0 Linear rows, no stable DEV origin | Phase G, mostly owner-blocked |
| EGA-768 | — | — | HOLD | — | — | — | **not touched** |

---

## 5. Owner actions required (exact)

| # | Action | Where | Why it blocks | How to verify |
|---|---|---|---|---|
| 1 | Create a Linear OAuth app; set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1` | Convex DEV `hardy-warthog-60` | Without a Linear client there is no OAuth, no issue read, no status write, no mapping | `npx convex env list --names-only` shows the three names; a Linear connection row appears after one consent |
| 2 | Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for the **Clerk development** instance (`climbing-pegasus-6180`) | Vercel, Helm project | The owner grant exists but the browser cannot authenticate without the publishable key | Owner sign-in succeeds on the DEV origin |
| 3 | Establish a **stable DEV origin** (a Vercel environment/branch alias, not a per-PR Preview) and set `HELM_APP_URL` to it | Vercel | OAuth redirect URIs and the same-origin checks need one stable origin; previews are not DEV | `HELM_APP_URL` equals the DEV origin; the origin serves the app |
| 4 | Grant this environment access to the `ega-builds` Vercel scope, or perform action 3 yourself | Vercel account | The CLI scope does not exist here, so Helm's Vercel project cannot be administered or configured from this session | `vercel ls --scope ega-builds` succeeds |
| 5 | Complete one T3 consent with `operate` scope against an **isolated** DEV T3 endpoint | T3 | The only existing DEV connection is `read-only` and points at production T3; escalating that endpoint is production-permission escalation, which is out of scope | A `t3Connections` row with `access: "operate"` on a non-prod endpoint |
| 6 | Provide a read-only `GITHUB_TOKEN` (`Pull requests: read`) | Convex DEV | EGA-766 verification returns `verification_unavailable` without it — correct, but not verifiable | A verified PR state appears instead of `verification_unavailable` |
| 7 | Complete one Linear OAuth consent and create at least one Linear↔T3 project mapping | Helm DEV | EGA-685 steps 3–6 | `linearConnections` and `linearProjectMappings` each have ≥1 row |
| 8 | Approve merges of the nine PRs into `develop` | GitHub | The mission authorises integration, but never into `main` | `develop` contains the stack |

---

## 6. Phase D — integration sequence (derived from ancestry, not assumed)

```text
after #21 lands in develop, these four PR heads become ancestors of develop
and therefore auto-mark as MERGED — truthfully, because their content is there:

  #20  df9c7b5   shared operate gate
  #18  6cde5b8   EGA-764
  #19  506e9f2   EGA-765
  #24  61e0337   EGA-766 core
```

These four still need their own merge, and this is the order:

| Step | PR | Content | True standalone diff at that point |
|---|---|---|---|
| 1 | **#21** | gate + 764 + 765 + 766 + lead wiring + ledger | 56 files, +9665 −33 |
| 2 | **#25** | EGA-762 association + sync ledger | 12 files, +3662 −2 |
| 3 | *B3 PR* | EGA-762 product sync trigger (stacked on #25) | new |
| 4 | **#26** | EGA-763 manual linking backend | 15 files → only its own 5 commits after #25 |
| 5 | *B4 PR* | EGA-763 manual-link UI (stacked on the integration candidate) | new |
| 6 | **#22** | EGA-770 hosted DEV config + runbook | 7 files, +869 −1 |
| 7 | **#23** | EGA-769 operate consent — **manual conflict resolution required** | 11 files, +227 −27 |

**Why #21 must be first.** PRs #18 and #19 each modified `convex/t3WriteCapability.test.ts` and
each dropped the other's assertion. Merging them into `develop` independently would conflict on
that file. The integration branch is the only place the conflict is already resolved — it asserts
all three write routes independently plus the read-only attention route. So #21 is the single
correct path for 764+765 to land, and #18/#19 correctly become merged-by-#21.

**Why #23 needs manual resolution.** Its merge-base is `9682ed7`, which is inside #21. Its 11-file
diff touches `Dashboard.tsx` and `useT3Dashboard.ts`, which the lead's wiring also changed. The
3-way merge must retain **both** the 769 access-gating work and the lead's
`AttentionBadge` / `reloadActivity` / verified-PR panel. Neither side may be overwritten.

**Sequencing decision.** The cumulative Phase C review of the **complete** candidate (integration +
B3 + B4) happens **before** the first merge into `develop`, so `develop` only ever receives
fully-reviewed code. The integration candidate is proven at `0396c66` (lint 0, typecheck, 522
backend, 357 frontend, build pass) and the merged write-route guard is verified to assert all
three routes independently.

## 7. Open questions under review

### 7a. B3 review outcome — 2 blocking, 8 major; the lane's own claims were not all true

The reviewer confirmed the mechanics that matter (the launch trigger cannot alter a launch outcome,
the owner grant is re-verified before every write, no sync path can reach native T3 work, the
no-Linear-connection case fails closed with zero writes, and `MAX_RETRY_ATTEMPTS` is **not** an owner
dead end) and independently **proved the cron registers** by reading the Convex backend source:
`CRON_PATH = "crons.js"`, the default export must be a `Crons` object with `isCrons === true`, and
`convex.json` is optional CLI configuration rather than a crons registry.

But it found the lane's own safety claims were not backed by the code:

| # | Finding | Severity |
|---|---|---|
| F1 | **`pnpm lint` fails** — 4 eslint errors in the new test file, so CI is red. The lane reported lint as passing | blocking |
| F11 | **9 dead aliases** ship as 9 individually callable Convex functions, not inert constants | blocking |
| F2 | The diff breaks the repo's own "nothing schedules, auto-retries" contract in 4 places, including a **persisted** schema comment | major |
| F3 | Manual rows are **not** skipped in the immediate path — the automatic path creates and writes a manual association's ledger row | major |
| F4 | The `provenance === "manual"` branch is **dead code** — no such column exists on this branch | major |
| F5 | The cron is **not** the safety net for a dropped trigger — `pending` rows are never returned by the driver | major |
| F6 | The cron and the immediate trigger **can double-write** for one issue in one window — no lock, no issue-identity dedup | major |
| F7 | The trigger is **not idempotent at the scheduling level** — a reused launch schedules a second sync | major |
| F8 | The "bounded exponential backoff" **never engages**: the cron period is 60s and the backoff caps at 60s, so a failing row is hit ~10× in 10 minutes, and a `429` row is re-hit every minute — the driver sustains the rate limiting it is clearing. No jitter | major |
| F9 | 1440 wakes/day; up to 500 rows driven **sequentially** inside one action (can exceed the action limit); rows read in creation order with **no cursor**, so later rows starve | major |
| F10 | Two of the lane's four new tests are **vacuous under mutation**; the "one Linear write" stub never reaches the `synced` path; no test at all for the launch→scheduler wiring | major |
| F13 | Every skip path increments one counter and the reason is discarded | minor |

Two of these deserve emphasis because they are the kind of defect a green suite hides:

- **F8**: the backoff was *written* to look bounded and *measured* to be inert. The ramp sits at the
  cron period, so `attemptCount` changes nothing about the cadence.
- **F9**: the driver reads rows in creation order with no cursor, so the oldest rows are always
  processed first and later rows starve until the early ones exhaust their attempt budget — a
  self-defeating queue.

**New residual from the review:** Convex discovers the cron **silently by filename**. If
`convex/crons.ts` were renamed, **zero** crons would be installed, with no error, and `convex-test`
does not evaluate the crons module at all. A source-level guard asserting the file exists and
default-exports a `Crons` object was added to the repair brief.

### 7c. Process rule adopted after the first rate-limit interruption

Two worker sessions were cut off by a provider rate limit **mid-edit**:

- **B3 repair round 2** — 8 files modified but **uncommitted**, plus a new untracked
  `convex/cronGuard.test.ts`. The two blocking items were already done in that working tree (the nine
  aliases deleted, the lint errors cleared), so the work was preserved on disk and continued by a
  **fresh** worker on a different provider, told explicitly to run `git diff` first and never to
  `git checkout --` / `git reset` / `git stash` the pending changes.
- **B4a** — nothing had been written yet; re-dispatched on a different provider.

**Rule adopted: a worker's own report is never the evidence.** Concretely, in this run:

| Worker claim | Reality |
|---|---|
| "lint: 0 errors" (B3 round 1) | `npx eslint` → **4 errors**, exit 1. CI was red. The reviewer's mutation table caught it; the worker had not run the repo's lint config |
| "browser 70 passed" (B4b) | `pnpm test:frontend` was **not run** — two of its own unit tests failed. Caught only because the lead ran the full gate set locally |
| "conforms to the documented Convex cron contract" (B3) | True, and the reviewer then proved it from the Convex *backend* source rather than the type docs |

So: the gate set is run by the lead on every candidate head, not only by the worker that produced it,
and a green claim in a report is never recorded as evidence without the lead's own run.

### 7d. B4 (manual-link UI) — verified by the lead at `0bb9ff1`

`lint 0 errors · typecheck pass · 522 backend · 363 frontend · build pass`. The two failures the
worker shipped were a **render-gating** defect: the link/reassign affordance was rendered only when
`mappings !== null`, and `mappings` is loaded in an effect that `renderToStaticMarkup` never runs —
so the whole form (and the launch-evidence refusal copy) was absent from the static render. The
affordance is now rendered unconditionally and disabled with an honest reason while the list loads,
which is also better product behaviour: the owner sees that linking is possible instead of an empty
section.

### 7e. Defect found by the B4 lane: EGA-763's backend had no **read** path

Building the owner-facing manual-linking screen exposed a gap that backend-only review could not
see: `convex/linearManualLink.ts` exposes exactly three public actions — `link`, `unlink`,
`reassign` — and **no read**. `associationForThread` exists only as an *internal* query in
`linearAssociationStore.ts`, so Next cannot reach it.

Consequences, both release-relevant:

1. **Reload-recovery is impossible** — the mission's B4 requires the owner to "recover the
   association after reload". Without a read, the UI must assume unbound.
2. **The owner has no `expectedAssociationId`** — the optimistic-concurrency token that unlink and
   reassignment require. The UI would have had to guess it, which is exactly the last-write-wins
   behaviour the EGA-763 review fought.

The B4 lane's own GET route was meanwhile a **stub**: it authorized the caller and then returned a
hard-coded `{ association: null }`, while its doc comment claimed it "re-reads the durable binding".

Two lanes dispatched to close it, on disjoint files:

| Lane | Branch | Work |
|---|---|---|
| B4a | `feat/helm-v0.2-ega-763-manual-links` (#26) | Add the owner-gated public action `readAssociation`, using the **exact** `by_owner_thread_unlinked` / `eq(unlinkedAt, 0)` lookup that made the one-binding invariant real. Typed returns, not `v.any()`. The three existing actions also declare `returns: v.any()`, so the Convex validator cannot reject a malformed response the UI depends on. |
| B4b | `feat/helm-v0.2-ega-763-manual-link-ui` (B4) | Make the GET route call that action by the same string function reference the other routes already use, surface the backend's cross-connection refusal distinctly, and take the concurrency token from the **recovered** association. Add a browser test proving reload-recovery. |

The action name and shape are fixed in both briefs so the halves agree. #26 must land before the
B4 PR — which is already the planned order.

### 7b. Open review questions

| # | Question | Owner |
|---|---|---|
| B3-i | **RESOLVED by the lead — in the author's favour.** Convex 1.46's own type documentation (`node_modules/convex/dist/cjs-types/server/cron.d.ts:143-160`) shows the exact convention: `// convex/crons.js` → `import { cronJobs } from 'convex/server'` → `const crons = cronJobs()` → `export default crons`. The `Crons` class carries an `isCrons: true` marker (`:180`) which is also emitted in the runtime bundle (`dist/cjs/server/*.js`), i.e. it exists for bundle auto-detection. **No `convex.json` is required for this API in 1.46** — the worker's `convex/crons.ts` with `export default crons` matches the documented contract. The absence of the string `crons.ts` in `dist/cli/` is because detection is marker-based, not filename-literal. The independent reviewer is still confirming. |
| B3-ii | **11 alias exports** for two new entry points. The same standard applied to EGA-763 (15 aliases removed) applies here. | B3 reviewer |
| B3-iii | Cron period is 1 minute and internal backoff caps at 60s — is the backoff able to delay anything, and is a 1-minute forever cron appropriate? | B3 reviewer |

---

## 8. Resume point

### 8a. The assembled release candidate

`candidate/helm-v0.2-release` = **`9aa1d78`** (pushed). It merges the whole v0.2 stack onto the
integration candidate:

```text
9aa1d78  candidate: assemble the complete v0.2 release candidate and correct merged copy
  c3b237d  EGA-769 operate consent            (#23)
  8dd944d  EGA-763 manual linking UI         (#27)
  138174c  EGA-770 hosted DEV configuration   (#22)
  9970855  EGA-763 manual linking backend     (#26)
  fb7b742  EGA-762 association + sync ledger  (#25)
  f830fcc  EGA-766 verified PRs + lead wiring (#21)
  edd48da  EGA-764 coverage repairs          (#18)
  9682ed7  EGA-765 confirmation reset         (#19)
```

Gates on that exact head: **lint 0 errors (1 pre-existing warning) · typecheck pass · 630 backend ·
373 frontend · build pass · browser 74/74**.

Two findings from the assembly itself:

- **Only `convex/_generated/api.d.ts` ever conflicted**, and it was regenerated with codegen rather
  than hand-merged. The two lanes that had collided before (`t3WriteCapability.test.ts`) did **not**
  collide here, because the integration branch already carries the merged guard.
- **A clean textual merge is not automatically a correct merge.** The merged Dashboard was inspected
  by hand: 769's access gate (`canOperateSelected = threadConnection?.access === "operate"`), the
  lead's `AttentionBadge` / `reloadActivity` / verified-PR panel, and the manual-link mount are all
  present and coherent. It did leave **one piece of copy false** — the overview still said *"Linear
  status sync and verified PR checks are not implemented yet"*, which was true when 769 wrote it and
  is false in this tree. Corrected to state what is actually available, including that linking
  creates a binding only and never changes an issue state.

This candidate is also the **dry run for Phase D**: because the same ancestry produced no conflicts
here, merging the PRs into `develop` one at a time is expected to be clean, with the #23 reconciliation
already proven to be a non-conflict.

**Still missing from the candidate: the B3 sync trigger** (its repair is in flight). Phase C's
cumulative review must run on the candidate *after* B3 lands, so the reviewed tree is the tree that
will ship.

### 8b. The B3 ↔ EGA-763 reconciliation — the delicate part

B3 and EGA-763 both changed `convex/linearSync.ts`, `convex/linearSyncStore.ts` and
`convex/schema.ts`. The conflicts were **not** textual noise: two features with different semantics
claiming the same code. EGA-763 says a manual link is *"bound, no status change requested"* and
must never be synced automatically; B3 says the two drivers share one contention point and must not
double-write. Resolved as a **union**, per hunk:

| Hunk | Resolution |
|---|---|
| `schema.ts` state union | **all** of `pending`/`linked`/`manual`/`syncing`/`synced`/`conflicted`/`retryable`/`authorization_required`. `linked`/`manual` are EGA-763's manual binding; `syncing` is B3's in-flight claim |
| outcome vocabulary | Both sides defined the **same four literals** under different names (`syncOutcomeStateLiteral` vs `ledgerOutcomeLiteral`). Kept one name, updated every reference, so an outcome can never be a row state |
| association query | Kept B3's `allAssociations`, because the surviving code already filters it by `attemptId` for automatic mode — that filter **is** the load-bearing manual exclusion |
| the substantive hunk | Kept B3's `mode` split, already-synced no-op and `syncing` claim, **and** added EGA-763's `optInManual` on the operator path |
| `OPEN_LEDGER_STATES` | The union: `linked` (a manual binding must be visible to the operator) and `syncing` (a row that stuck in flight must not be invisible) |

Two contract mismatches surfaced **only by merging** and were fixed:

- `ensureAssociation`'s args required `unlinkedAt`, but the store always writes `0` on create and
  never reads it from args. Requiring it from callers was redundant and broke every pre-existing
  caller, so the marker is now **store-owned**: required on the table, optional in args. No caller
  can create an already-tombstoned row.
- `performSync`'s args did not carry `allowManual`, which EGA-763's operator opt-in needs.

**One test assertion was changed, deliberately.** B3's F4 test asserted the ledger has **no**
`provenance` column — true on B3's branch, false in this tree, because EGA-763 adds a real one.
Rather than delete the property, the test now proves it **behaviourally and more strongly**: it
labels a manual row `"launch"` in the ledger and shows the driver still leaves it alone, because it
is the *association's* `attemptId` that makes it manual. A source grep could never prove that.

The candidate is now **`5a826ac`** (pushed): lint 0 errors, typecheck pass, **650 backend / 373
frontend / 74 browser**, build pass. Phase C's cumulative review runs on that exact head.

### 8c. Phase C round 1 — 1 blocking, 3 majors, and a gate claim that was not reproducible

The cumulative review of the merged tree found real defects **that no per-lane review could have
found**, because they exist only in the union:

| | Finding | Consequence |
|---|---|---|
| **F1 (blocking)** | The manual-linking **read** was dead in a real browser. `requireSameOrigin` demands an `Origin` header and browsers do not send one on a same-origin GET, so every legitimate read was refused — and after a *successful* link the failure copy claimed the deployment was misconfigured. It was the only GET in the app using the strict helper; the two sibling GETs already used the correct Origin-or-Referer rule | EGA-763's owner-facing feature was non-functional, and the browser suite could not see it because the spec stubs the route |
| **F2 (major)** | A manual link **adopted** by an accepted launch was silently never synced: adoption re-armed the association but left the ledger row `linked`, which no driver owns, and the launch path only scheduled for a *newly created* association | The merged semantics the lead believed were reconciled were not |
| **F3 (major)** | The **launch path's** thread-binding check was still a windowed scan (`take(100)` then filter tombstones) while EGA-763 had fixed the *manual* path to an exact index. At ≥100 tombstones the live row fell out of the window and the launch path created a **second active binding** | The one-binding-per-thread invariant broke on the launch path |
| **F4 (major)** | The "650 backend tests pass" claim was **not reproducible**: `npx vitest run convex/t3Launch.test.ts` failed 1 of 29, deterministically, while the full suite passed | A green-gate claim that did not hold under per-file shards |
| **F5 (minor)** | `openLedger` reads one bucket per state with awaits in between, so a row that moves buckets mid-read is listed **twice** | The mechanism behind F4 |
| **F6–F10 (minor)** | Stale merge leftovers (a comment claiming the ledger has no `provenance` column; write-allowlist comments describing one tool instead of three); the unreachable `manual` literal; ledger provenance asymmetry; the panel always claiming "state linked"; the operator opt-in having no UI; the execute panel never being mounted; and the mixed-issue/no-opt-in case being **unpinned** (a mutation that always included manual associations passed every test) | |

**All four substantive findings are fixed and each is mutation-proven:**

| Finding | Fix | Proof |
|---|---|---|
| F1 | shared `requireSameOriginGet` (Origin-or-Referer) used by all three GETs; the strict helper still guards every POST | new route-level test **fails** against the old strict guard |
| F2 | adoption re-arms the ledger row to `pending` with provenance `launch`, reports `adopted: true`, and the launch path schedules on `created \|\| adopted` | new test drives the whole path to one Linear write and `synced` |
| F3 | the launch path now uses the exact `by_owner_thread_unlinked` / `eq(unlinkedAt, 0)` lookup, and >1 active row is a loud error | new test with 100 tombstones **fails** against the old windowed scan |
| F4/F5 | `openLedger` dedupes by ledger id; the N6 test drains the scheduler instead of depending on timer timing | standalone now 3/3, full suite green |
| F6/F8/F10 | comments corrected; `readAssociation` returns the binding's real sync state; `manual` added to the queue so it can never be invisible; the mixed case now pinned | the mixed-case test **fails** when manual associations are always included |

Candidate after these fixes: **`2834579`** — lint 0 errors, typecheck pass, **653 backend / 378
frontend / 74 browser**, build pass.

*Note on the commit message of `2834579`: a backtick in the message was interpreted by the shell, so
one bullet reads "- was a reachable-looking literal" where it should read "- \`manual\` was a
reachable-looking literal". The wording is corrected here; the commit was not force-pushed, because
force-pushing is prohibited.*

### 8d. Phase C round 2 — 0 blocking, and the proof gaps it found

Round 2 confirmed every substantive fix by re-running the reviewer's **own** round-1 probes rather
than my tests: the browser read now works, the POSTs are not weakened, an adopted binding is synced
exactly once, and a thread with a hundred tombstones is still bound to one issue. **All ten focus
areas PASS.**

It also found that some of my committed tests did not actually *prove* what they claimed, and that
one of my claims was false:

- **R2-d** — the F3 test passed against the very defect it names, because it created the tombstones
  *after* the live row. A windowed index range reads the oldest rows first, and in production the
  live row is always the **newest**. The test now creates the tombstones first; it **fails** against
  the windowed scan.
- **R2-a** — the `created || adopted` scheduling was unpinned. New test: a real launch that adopts a
  manual binding schedules a sync and drives the issue to `synced`. It **fails** when the scheduling
  is reverted.
- **R2-e** — my brief claimed a trigger-side mislabel test existed. **It did not.** One is now
  added; the protection is pinned through the shared `performSync` filter (dropping the automatic
  `attemptId` filter still fails three tests), and the commit says so honestly rather than
  overstating it.

Final candidate: **`e76a9cb`** — lint 0 errors, typecheck pass, **655 backend / 378 frontend / 74
browser**, build pass, and `npx vitest run convex/t3Launch.test.ts` standalone **29/29 twice over**,
so the gate claim is now reproducible.

### 8e. Phase D — integrated into `develop`

`develop` went `f67f607` → **`39ab711`** ("Helm v0.2 release candidate: the complete integrated
stack"), a **merge commit** so the full ancestry stays visible. `develop`'s tree is **byte-identical**
to the reviewed candidate — nothing lost, nothing duplicated — and `develop`'s own gates were re-run
on its tree: lint 0 errors, typecheck, **655 backend / 378 frontend**, build pass.

All eleven branch heads are ancestors of `develop`; every v0.2 PR now reads MERGED (#28 closed with
an explanation, because its base branch is not itself reachable from `develop` and the UI could not
mark it).

### 8f. Phase E — hosted DEV (real, and a Production near-miss worth recording)

**The release candidate is deployed to the Convex DEV deployment** `hardy-warthog-60`
(team `helm`, project `helm`, type `dev`): `convex dev --once` reported *"Convex functions ready!
(11.59s)"* and applied the two new exact-lookup indexes
(`linearIssueThreads.by_owner_issue_thread_unlinked`, `by_owner_thread_unlinked`). Deployed function
count went **50 → 120**. The new tables exist and are **empty**, so the periodic driver has no
obligation and performs no write.

**A near-miss with Production, recorded because it matters:** `npx convex deploy` targets the
project's **default production deployment** (`polite-anaconda-886`) *by design* — it prompted
*"Do you want to push your code to your prod deployment polite-anaconda-886 now?"* and aborted only
because the terminal cannot prompt. Nothing was uploaded. Production and DEV both still report
deployment version `20261019T225417Z-6b6e14767de5`, and `main` is unchanged at `0e863c4`. **The
production deployment was not modified.** Use `convex dev` for a DEV deployment; `convex deploy` is a
production operation.

**The machine-checked DEV configuration verdict** — EGA-770's own validator, run against the live DEV
deployment, reporting **variable names and problems only, never values**:

```text
environment.ok = false          readyForHostedDiscovery = true
dispatchEligibility = isolated_incomplete     readyForIsolatedDispatch = false
```

| Variable | Verdict | What the owner must do |
|---|---|---|
| `LINEAR_CLIENT_ID` | missing | Create a Linear OAuth app; redirect URI `<HELM_APP_URL>/api/linear/callback` |
| `LINEAR_OAUTH_ENCRYPTION_KEY_V1` | missing | Configure a retained 32-byte AES key, base64-encoded |
| `T3_OAUTH_ENCRYPTION_KEY_V1` | **malformed** | The value is set but is **not** a base64 encoding of exactly 32 bytes |
| `T3_PROJECT_ID_ISOLATED` | missing | The trusted isolated T3 project binding; **missing disables dispatch** (native launch/send/interrupt) |

`NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` report `not_observable_from_convex`,
which is correct — they are Vercel-side and cannot be seen from Convex.

### 8g. Phase E — REAL hosted receipts (read-only probes run from the DEV Convex runtime)

EGA-770's probe functions are deployed on DEV, and every one of them is a read-only pass-through.
Run against the live deployment, they produced genuine hosted evidence — not mocks:

**Hosted T3 MCP handshake** (`runHostedT3McpVerification`)

```text
ok: true          initialize: success      toolsList: success
tokenConfigured: true                      endpointConfigured: true
toolCount: 83     toolsWithInputSchema: 83
durationMs: 4500  errorClass: null
```

**Hosted T3 catalog/project discovery** (`runT3Discovery`)

```text
ok: true          capabilities: available   projects: available
```

**Linear access, using DEV's own stored `LINEAR_API_KEY`** (`runLinearVerification`)

```text
authentication: verified                   projectAccess: verified
issuesAccess: verified                     configuredProjectMatchesHelm: true
moreIssuesAvailable: true                  sampledIssueCount: 1
```

**What these change.** The blockers are *narrower* than a first reading suggested:

| Capability | State on DEV | Why |
|---|---|---|
| Hosted T3 MCP transport | **WORKS** — 83 tools with input schemas | the DEV endpoint + token are configured and reachable |
| Hosted T3 discovery (projects, catalog) | **WORKS** | `T3_MCP_URL` + token present |
| Linear **API** read (project, issues) | **WORKS** | `LINEAR_API_KEY` + `LINEAR_PROJECT_ID` present |
| Helm's **Linear OAuth** connection | **BLOCKED** | `LINEAR_CLIENT_ID` and `LINEAR_OAUTH_ENCRYPTION_KEY_V1` missing |
| Native **dispatch** (launch / send / interrupt) | **BLOCKED** | `T3_PROJECT_ID_ISOLATED` missing → `readyForIsolatedDispatch: false` |
| T3 OAuth token encryption | **BROKEN** | `T3_OAUTH_ENCRYPTION_KEY_V1` is set but **malformed** (not base64 of exactly 32 bytes) |
| GitHub PR verification | **BLOCKED** | no `GITHUB_TOKEN` → `verification_unavailable` (fail-closed, correct) |

So the R01–R12 journey is not uniformly blocked: the read paths and the T3 transport are live on
DEV today. What is missing is precisely the chain that would let an **owner in a browser** drive
it — Helm's own OAuth consent, the isolated dispatch binding, a stable origin, and the Clerk
browser keys.

**The malformed key is a genuine DEV defect, not just a missing one.** `T3_OAUTH_ENCRYPTION_KEY_V1`
is present but is not a base64 encoding of 32 bytes, so the T3 token encryption path cannot be
trusted on DEV even though a T3 connection row exists.

**What this proves:** hosted T3 discovery works, and the schema delta applies cleanly to a
real Convex deployment. **What it proves not:** native dispatch is disabled (no
`T3_PROJECT_ID_ISOLATED`), so the launch→association→sync chain cannot be exercised on DEV at all.

Next exact actions, in order:

1. Push `2652bb5` (EGA-766 wiring + this ledger) to the integration branch; verify CI on PR #21.
2. Dispatch implementation for **B3** (EGA-762 product sync trigger) and **B4** (EGA-763 Dashboard UI).
3. Phase C: independent review of the complete integrated implementation.
4. Phase D: integrate one PR at a time into `develop` in the safe order — **#21 first** (it is the only
   place the 764/765 guard conflict is resolved), then #24, #25, #26, #22, then the restacked #23.
5. Phase F: EGA-767 reliability certification on the integrated candidate.
6. Phase E/G: hosted DEV acceptance — gated on owner actions 1–7.
7. Phase H: GO/NO-GO. **Do not merge to `main`. Do not promote Production.**
