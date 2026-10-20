# HELM v0.2 — Release Closure Ledger

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

### 7b. Defect found by the B4 lane: EGA-763's backend had no **read** path

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

Next exact actions, in order:

1. Push `2652bb5` (EGA-766 wiring + this ledger) to the integration branch; verify CI on PR #21.
2. Dispatch implementation for **B3** (EGA-762 product sync trigger) and **B4** (EGA-763 Dashboard UI).
3. Phase C: independent review of the complete integrated implementation.
4. Phase D: integrate one PR at a time into `develop` in the safe order — **#21 first** (it is the only
   place the 764/765 guard conflict is resolved), then #24, #25, #26, #22, then the restacked #23.
5. Phase F: EGA-767 reliability certification on the integrated candidate.
6. Phase E/G: hosted DEV acceptance — gated on owner actions 1–7.
7. Phase H: GO/NO-GO. **Do not merge to `main`. Do not promote Production.**
