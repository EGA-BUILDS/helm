# Helm v0.2 — orchestration ledger (append-only)

Integration branch: `develop`. Integration HEAD at run start and still:
`bc1fee829bc98c48e8763099ac5fe52090fc0569`.

This ledger is a resumability record. Authoritative remote progress lives in the
Linear issues and the pull requests themselves; this file only consolidates.

Reading rules:
- "PR_READY" means a reviewable PR exists with green checks. It does **not** mean
  merged, integrated, deployed, or accepted.
- An unmerged PR is never treated as integrated into `develop`.
- `NOT TESTED` is recorded honestly and is never upgraded to a pass by inference.

---

## RUN 2 — Wave 0 reconciliation (verified, not recalled)

Re-derived from live GitHub and Linear state before doing anything.

| Check | Result |
|---|---|
| `origin/develop` | `bc1fee829bc98c48e8763099ac5fe52090fc0569` — **unchanged**; nothing merged |
| PR #8 head | `9625b2c13ae0845ac7d72ab1b5449c093cf1cf16` — MERGEABLE / CLEAN, all checks green |
| PR #9 head | `48d6b9b1e01b4c9be0cc0b9a7b74bd5551f3ba9d` — MERGEABLE / CLEAN, all checks green |
| PR #10 head | `c63ad0a413fa3b0e66b249e479bfaaa91e11a54d` — MERGEABLE / CLEAN, all checks green |
| Linear tracker | all three had reverted to **Backlog** |
| EGA Skills MCP | `needs_auth` — OAuth refresh token invalid; owner re-auth required |
| Stale PRs | #4/#5 are **fully contained** in develop; **#3 is NOT** — 23 files / +2876 lines unique to it |
| PR #3 collision | it defines its own `projectMappings` table (singleton, env-var sourced), superseded by the v0.2 owner-scoped model; EGA-760 uses `linearProjectMappings` to avoid any collision |

### Tracker reconciliation (root cause found)

The previous run's `In Review` writes never applied: `linear.save_issue` takes **`state`**,
not `status`, and an unknown parameter is silently ignored. Re-applied with the correct
field and re-read to confirm:

```
EGA-757 -> In Review   EGA-759 -> In Review   EGA-682 -> In Review
```

### Combined-integration regression check (new evidence)

The three PRs were merged into a throwaway branch on top of `develop` — **no conflicts** —
and the full suite was run on the combined tree:

```
lint 0 errors (1 pre-existing warning) | typecheck pass
pnpm test             216/216   (16 files)
pnpm test:frontend    202/202   (6 files)
pnpm build            pass      (11 routes incl. all 5 /api/linear/* and all /api/t3/*)
pnpm test:frontend:browser  40/40
```

Separately-passing branches can still regress in combination; on this evidence they do
not. This is a **static/test** result — it is not hosted DEV acceptance.

### DEV provisioning delta (re-measured)

`HELM_OWNER_SUBJECT`, `CLERK_FRONTEND_API_URL`, `HELM_APP_URL`, `HELM_REPOSITORY`,
`HELM_BASE_REF`, `T3_OAUTH_ENCRYPTION_KEY_V1` and the historical `T3_MCP_*` /
`LINEAR_API_KEY` variables **are set** on DEV Convex. The v0.2 Linear OAuth namespace
(`LINEAR_CLIENT_ID`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`) is **not set**. Every table is
still empty. Full detail and the exact owner actions are in
[`OWNER-ACTIONS.md`](./OWNER-ACTIONS.md).

### Dispatch plan for run 2

```
Lane A (only unblocked chain)  EGA-760 -> EGA-680 -> EGA-761
   base: stacked on PR #9 (D03) because D04 consumes the Linear connection
Lane B                          blocked: EGA-758 IS the DEV write probe (owner GO required)
Lane C                          blocked: needs D07/D08 which need D02
Production                      EGA-768 remains HOLD
```

Lane A is a strict dependency chain, so it is serial by necessity; parallelism is not
available merely because three workers are permitted.

---

## RUN 2 — Wave 1 records

### D04 / EGA-760 — Linear project → native T3 mappings

```text
Issue:        EGA-760
Worker:       delegated subagent (opencode-go/muse-spark-1.3-contributor), lead-reviewed + lead-repaired
Branch:       feat/helm-v0.2-ega-760-project-mappings
Base SHA:     48d6b9b1e01b4c9be0cc0b9a7b74bd5551f3ba9d   (PR #9 head — intentional stack)
Head SHA:     ef2dabae91abc3e2b8dec43e39774004fc0866ff
Status:       PR_READY (stacked; In Review in Linear)
PR:           https://github.com/EGA-BUILDS/helm/pull/11
Deliverable:  linearProjectMappings table, convex/lib/linearGraphql.ts,
              convex/projectMappingsStore.ts, convex/projectMappings.ts (list/candidates/
              save/disable), 3 same-origin routes, src/features/linear mappings surface
Checks:       lint 0 errors | typecheck pass (clean tsc) | 245/245 backend | 208/208 frontend
              | build pass | browser 40/40 | CI on PR #11 all green
Real DEV:     NOT TESTED (no live Linear/T3 connection)
Review:       lead review found the first revision required exactly ONE "started" workflow
              state and ignored the caller's selection, so any real team with both e.g.
              "In Progress" and "In Review" could never be mapped. Repaired so the owner
              chooses and the server validates the choice against a live read; zero states
              still fails closed. Also removed dead caller-supplied label params, and
              renamed the table to linearProjectMappings to avoid the PR #3 collision.
Next action:  owner review of PR #11 (after #9)
```

New finding recorded this wave:

- **F12 (High, fixed):** a mapping could not be created for any Linear team with more
  than one `started` workflow state, which is the common real case. The contract now
  separates *candidate discovery* (list every started state) from *selection*
  (owner-supplied id, validated against that team's live states).

CI on PR #11: Application verification (Node 22, Node 24), Frontend browser, Vercel — all pass.

### D05 / EGA-680 — Linear issue browsing

```text
Issue:        EGA-680
Worker:       delegated subagent (opencode-go/muse-spark-1.3-contributor), lead-reviewed
Branch:       feat/helm-v0.2-ega-680-issue-browser
Base SHA:     ef2dabae91abc3e2b8dec43e39774004fc0866ff   (PR #11 head — intentional stack)
Head SHA:     8bd5d5d50556c62c114f08ae866e4c08ae1ad4d5
Status:       PR_READY (stacked; In Review in Linear)
PR:           https://github.com/EGA-BUILDS/helm/pull/12
Deliverable:  convex/lib/linearIssues.ts, convex/linearIssues.ts (browse/read), additive
              enabledMappingsForProject query, 2 same-origin routes,
              src/features/linear/issues.ts + IssuesPanel.tsx
Checks:       lint 0 errors | typecheck pass (clean tsc) | 265/265 backend | 219/219 frontend
              | build pass | browser 40/40 | CI on PR #12 all green
Real DEV:     NOT TESTED (no live Linear connection)
Review:       no repairs required. Verified: browsing is restricted to enabled mappings (an
              arbitrary project id cannot be browsed); GraphQL 200-with-errors is surfaced in a
              sanitized errors[] rather than silently emptying the list; the unfinished default
              filters by workflow-state TYPE not name; total is null rather than fabricated; text
              narrowing discloses textScope "loaded-page"; acceptance criteria are extracted only
              when genuinely present; there is no mutation path at all.
Risks:        the live project(id).issues(filter: IssueFilter) shape, the comparator operators
              and the omitted orderBy are unverified against real Linear; a live 400 fails
              closed with a classified error. The list query fetches description for page-local
              text narrowing, so an extreme page could approach the 1 MiB cap (fails closed).
Next action:  owner review of PR #12 (after #9 and #11)
```



---

## Environment facts established at run start

| Fact | Value |
|---|---|
| `origin/develop` | `bc1fee8…` — identical to the ticket baseline; nothing landed since the backlog was written |
| `origin/main` | `0e863c41…` (merge of PR #7) |
| DEV Convex | `hardy-warthog-60.eu-west-1`, 50 functions / 14 modules, **all tables empty** |
| Production frontend | Vercel ref `0e863c41`; canonical origin `https://helm-lyart.vercel.app` |
| Owner identity on DEV | none (`ownerGrants` empty) |
| Live native T3 connection on DEV | none (`t3Connections` empty) |
| Desktop browser attached | **no** (blocks real-browser evidence) |
| EGA Skills MCP | **not connected**; 0 Linear agent skills; primary `ship-one-outcome` present locally |
| EGA supporting skills (preflight-repository, build-execution-contract, record-evidence, review-and-ship, adversarial-review, certify-pr-head, verify-ui, integrate-pr-stack) | **not present** in the harness or the repo |
| Subagent models authorized & resolved | `opencode-go/muse-spark-1.3-contributor` (Muse Spark 1.3 Contributor); "DeepSeek V4.1 Flash Beam Free" has **no exact match** — nearest are `opencode/deepseek-v4.1-flash-free` ("DeepSeek V4.1 Flash Free") and `opencode-go/beam-free` ("Beam Free"); `opencode-go/beam-free` was used |

---

## Dependency graph used for dispatch

```
D01 EGA-757 (none)                    -> ELIGIBLE
D02 EGA-758 <- D01                    -> blocked (and needs owner DEV write authority)
D03 EGA-759 (none)                    -> ELIGIBLE
D04 EGA-760 <- D03                    -> blocked
D05 EGA-680 <- D04                    -> blocked
D06 EGA-761 <- D05                    -> blocked
D07 EGA-681 <- D02, D06               -> blocked
D08 EGA-762 <- D07, D04               -> blocked
D09A EGA-682 (none)                   -> ELIGIBLE
D09B EGA-763 <- D08, D09A             -> blocked
D10 EGA-764 <- D02, D09A              -> blocked
D11 EGA-765 <- D02, D09A              -> blocked
D12 EGA-766 <- D07                    -> blocked
D13 EGA-767 <- D08, D09B, D10, D11, D12 -> blocked
D14 EGA-685 <- D13                    -> blocked
D15 EGA-768 <- D14                    -> HOLD (owner authorization required)
```

Eligible set = {D01, D03, D09A} — exactly the three lanes the dispatch plan names.
Linear's native blocker fields are not exposed by the connected Linear tool, so the
`## Dependencies` sections of the issue descriptions were used as the authoritative
proxy and are consistent with the plan.

---

## Lane records

### D01 / EGA-757 — baseline + native T3 capability audit

```text
Issue:        EGA-757
Worker:       lead (own work, not delegated)
Branch:       feat/helm-v0.2-ega-757-baseline-audit
Base SHA:     bc1fee829bc98c48e8763099ac5fe52090fc0569
Head SHA:     49a14e445e17b390aa95c11db31d911be49e15c8
Status:       PR_READY (In Review in Linear; NOT Done)
PR:           https://github.com/EGA-BUILDS/helm/pull/8
Deliverable:  doc/v0.2/EGA-757-baseline-audit.md, doc/v0.2/ega-757-tool-matrix.json
Checks:       local lint 0 errors / typecheck pass / 191 tests / 186 frontend tests / build pass
              CI on PR #8: Application verification Node 22 PASS, Node 24 PASS, Frontend browser PASS, Vercel PASS
Real DEV:     NOT TESTED — DEV has no owner grant and no T3 connection; no desktop browser attached
Blockers:     owner provisioning of DEV (origin + Clerk owner + one DEV T3 consent)
Next action:  owner review of PR #8
```

### D03 / EGA-759 — Linear OAuth

```text
Issue:        EGA-759
Worker:       delegated subagent (opencode-go/muse-spark-1.3-contributor), lead-reviewed
Branch:       feat/helm-v0.2-ega-759-linear-oauth
Base SHA:     bc1fee829bc98c48e8763099ac5fe52090fc0569
Head SHA:     48d6b9b1e01b4c9be0cc0b9a7b74bd5551f3ba9d
Status:       PR_READY (In Review in Linear; NOT Done)
PR:           https://github.com/EGA-BUILDS/helm/pull/9
Deliverable:  2 additive schema tables, convex/linearOAuth.ts,
              convex/linearConnectionsStore.ts, convex/lib/linearHelpers.ts,
              5 /api/linear/* routes, src/lib/linearBackend.ts, .env.example
Checks:       lint 0 errors (1 pre-existing warning); typecheck pass; 216/216 backend;
              194/194 frontend; build pass; browser 40/40
              CI on PR #9: Node 22 PASS, Node 24 PASS, Frontend browser PASS, Vercel PASS
Real DEV:     NOT TESTED (no Linear credentials, no DEV owner, no identifiable browser)
Review:       lead review found a real defect — the first revision reused the
              T3-specific failure classifier, so Linear 429/5xx were misclassified
              as {unknown, retryable:false} and copy said "T3". Repaired in-branch
              (shared classifier core; classifyT3Failure output byte-identical).
Next action:  owner review of PR #9
```

### D09A / EGA-682 — unified native thread workspace

```text
Issue:        EGA-682
Worker:       delegated subagent (opencode-go/beam-free), lead-reviewed + lead-repaired
Branch:       feat/helm-v0.2-ega-682-native-thread-workspace
Base SHA:     bc1fee829bc98c48e8763099ac5fe52090fc0569
Head SHA:     c63ad0a413fa3b0e66b249e479bfaaa91e11a54d
Status:       PR_READY (In Review in Linear; NOT Done)
PR:           https://github.com/EGA-BUILDS/helm/pull/10
Deliverable:  per-project thread inventory + threadView mode; bounded all-projects
              fan-out with project-coverage-first paging; unambiguous (connection,
              project, thread) identity; scope toggle + provenance + partial state
Checks:       lint 0 errors (1 pre-existing warning); typecheck pass; 191/191 backend;
              194/194 frontend; build pass; browser 40/40
              CI on PR #10: Node 22 PASS, Node 24 PASS, Frontend browser PASS, Vercel PASS
Real DEV:     NOT TESTED (no live DEV T3 connection, no attached browser)
Review:       4 defects found by lead review and fixed in-branch: project coverage
              could never expand past 6 projects; bare-threadId selection could
              mis-attribute activity across projects; duplicated thread-view action
              surface; a new unused-parameter lint warning. A final integration pass
              removed the ambiguous 2-arg threadDetailKey overload by construction.
Next action:  owner review of PR #10
```

---

## Stop state

```text
ALL READY WORK DELIVERED.

Delivered: 3 verified reviewable PRs for the entire eligible set {D01, D03, D09A}.
          Each has a green exact-head CI run and an honest, partially NOT TESTED
          evidence record.

NOT done, and NOT claimed:
  - No merge was performed. No PR is integrated into develop.
  - No Production change, no credential widening, no OAuth regrant.
  - No native T3 write was attempted anywhere.
  - No real DEV acceptance evidence exists for any issue (see BLOCKED below).
  - EGA-768 (D15) remains on HOLD.
```

Remaining work is blocked by exactly two conditions, neither of which is code:

**DEPENDENCY BLOCKED** — every remaining issue requires an unmerged PR to be
integrated into `develop` first:

| Issue | Requires | State |
|---|---|---|
| D02 EGA-758 | D01 integrated **and** owner DEV write authority | blocked twice |
| D04 EGA-760 | D03 integrated | blocked (PR #9 unmerged) |
| D05 EGA-680 | D04 | blocked |
| D09B EGA-763, D10, D11 | D09A integrated | blocked (PR #10 unmerged) |
| D06–D08, D12–D14 | the chain above | blocked |

**AUTHORITY REQUIRED** — no issue's "real DEV" acceptance criterion can be satisfied
by anyone until the owner provisions DEV:

1. a deployed DEV origin and `HELM_APP_URL` in both runtimes;
2. a DEV Clerk owner identity (`HELM_OWNER_SUBJECT`, `CLERK_FRONTEND_API_URL`) and its
   `ownerGrants` row;
3. one DEV native T3 consent producing a `t3Connections` row;
4. a Linear OAuth client (`LINEAR_CLIENT_ID`/`LINEAR_OAUTH_ENCRYPTION_KEY_*`) for D03;
5. an explicit GO for the EGA-758 disposable DEV **write** probe, including whether an
   `orchestration:operate` grant may be requested;
6. merge authority for PRs #8/#9/#10, or a decision to leave them for review.

Stacking was considered and deliberately not used: continuing would mean stacking
D04→D05→D06→D07→D08→D09B on three unmerged PRs, which the run's integration policy
prohibits ("do not stack an unlimited number of dependent PRs").


---

## Deviations

| # | Deviation | Impact | Action |
|---|---|---|---|
| DV1 | EGA Skills MCP server is not connected and the six named supporting EGA skills are absent from the harness and the repo. Only the primary `ship-one-outcome` skill was loadable. | The supporting skill workflows were executed as the equivalent steps defined in the run prompt instead of their canonical definitions. | Recorded; primary skill used. Supporting skills cannot be claimed as executed. |
| DV2 | `npx convex codegen` was run once locally (documented as not modifying the running deployment); it added only the already-missing `lib/t3EndpointPolicy` binding to the committed bindings. | Deployment function surface re-measured afterwards and unchanged. | Recorded in the audit §9 (D-A1). |
| DV3 | No desktop browser is attached to this session, so real-browser evidence could not be captured for any issue in this run. | Every "real DEV browser" acceptance criterion is NOT TESTED. | Reported honestly; needs owner/browser access. |
| DV4 | Three stale open PRs (#3/#4/#5) target an already-merged foundation branch. | Could be mistaken for v0.2 work. | Recorded as audit finding F6; owner should close them. |
| DV5 | Playwright Chromium is not installed by default; the browser suite failed outright until it was installed to a shared path (`/home/ubuntu/projects/helm-worktrees/.pw-browsers`) via `pnpm exec playwright install chromium`. | The first browser-suite run in this run failed for an environmental reason, not a code defect; CI installs Chromium explicitly so CI was never affected. | Recorded; all three lanes were re-run with Chromium available and passed 40/40. |
| DV6 | A Linear OAuth client is not configured anywhere, and no DEV Clerk owner identity exists, so no real-DEV consent is possible in this run. | EGA-759's real-DEV criterion is NOT TESTED. | Owner action (see below). |

---

## Actions requiring the owner

1. Provision DEV so any real-DEV criterion can be tested: deployed DEV origin
   (`HELM_APP_URL`), DEV Clerk owner identity (`HELM_OWNER_SUBJECT`,
   `CLERK_FRONTEND_API_URL`) + `ownerGrants` row, and one DEV native T3 consent.
2. Grant or refuse authorization for the EGA-758 disposable DEV write probe
   (including whether an `orchestration:operate` grant may be requested).
3. Provide Merge authority for the v0.2 PRs, or leave them for owner review.
4. Decide whether to close stale PRs #3/#4/#5.
5. Confirm which Convex deployment the Production frontend targets, and pin the Clerk
   instance identity in ops docs.
