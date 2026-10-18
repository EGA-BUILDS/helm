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
Worker:       delegated subagent (opencode-go/muse-spark-1.3-contributor)
Branch:       feat/helm-v0.2-ega-759-linear-oauth
Base SHA:     bc1fee829bc98c48e8763099ac5fe52090fc0569
Status:       IN PROGRESS (candidate not yet verified by the lead)
```

### D09A / EGA-682 — unified native thread workspace

```text
Issue:        EGA-682
Worker:       delegated subagent (opencode-go/beam-free)
Branch:       feat/helm-v0.2-ega-682-native-thread-workspace
Base SHA:     bc1fee829bc98c48e8763099ac5fe52090fc0569
Status:       IN PROGRESS (candidate not yet verified by the lead)
```

---

## Deviations

| # | Deviation | Impact | Action |
|---|---|---|---|
| DV1 | EGA Skills MCP server is not connected and the six named supporting EGA skills are absent from the harness and the repo. Only the primary `ship-one-outcome` skill was loadable. | The supporting skill workflows were executed as the equivalent steps defined in the run prompt instead of their canonical definitions. | Recorded; primary skill used. Supporting skills cannot be claimed as executed. |
| DV2 | `npx convex codegen` was run once locally (documented as not modifying the running deployment); it added only the already-missing `lib/t3EndpointPolicy` binding to the committed bindings. | Deployment function surface re-measured afterwards and unchanged. | Recorded in the audit §9 (D-A1). |
| DV3 | No desktop browser is attached to this session, so real-browser evidence could not be captured for any issue in this run. | Every "real DEV browser" acceptance criterion is NOT TESTED. | Reported honestly; needs owner/browser access. |
| DV4 | Three stale open PRs (#3/#4/#5) target an already-merged foundation branch. | Could be mistaken for v0.2 work. | Recorded as audit finding F6; owner should close them. |

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
