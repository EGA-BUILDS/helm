# Helm v0.2 — reconciled current state

Date: **2026-10-23** (second audit revision)
This document supersedes the operational conclusions in older v0.2 reports. It
does not overwrite their historical evidence; where a claim is historical, it is
marked as such.

## 1. Repository state at this revision

| Fact | Value |
|---|---|
| `origin/develop` | `b85a8e3010d5c85b0b0b8f25709f6140901bc132` (PR #34 merged; **still Next.js 16.4.0**) |
| `origin/main` | `0e863c410cf5b0eba438d0e656794fce366880b6` (v0.1; **still Next.js 16.4.0**) |
| Latest merged PR | #34 — T3 OAuth consent guidance (2026-10-22) |
| DEV frontend | `https://dev-helm.egawilldoit.online` |
| DEV Convex | `dev:hardy-warthog-60` |
| Production | `main` only; EGA-768 remains HOLD; no v0.2 promotion |

Open **draft** PRs (none merged, none deployed):

| PR | Scope | Head |
|---|---|---|
| #35 | Native write-target safety | `38c6242` |
| #36 | Mounted execution review | `1bb2cbe` |
| #37 | Documentation, README, connection-error label | this branch |
| #38 | Next.js 16.4.2 patch for `develop` | `04aa9ea` |
| #39 | Next.js 16.4.2 patch for `main` | `215611b` |

Working tree had one untracked file (`doc/ORCHESTRATION_REPORT.md`), preserved in
the primary checkout. All work was done in isolated worktrees.

## 2. Method

Read the implementation, not just the documentation:

- entrypoints: `OwnerDashboard`, `Dashboard`, `useT3Dashboard`, `IssuesPanel`,
  `MappingsPanel`, `ExecutePanel`;
- T3 authorization and writes: `t3OAuth`, `t3ConnectionsStore`, `t3Launch`,
  `t3Send`, `t3Interrupt`, `launchAttempts`, `dispatch`, `lib/operateGate`,
  `lib/dispatchConfig`, `lib/writeTargetPolicy`;
- cross-system: `linearOAuth`, `projectMappings`, `linearAssociation`,
  `linearSync`, `verifiedPullRequest`, `src/app/api/linear/**`,
  `src/app/api/t3/**`;
- release evidence and Linear issues (read-only).

Status vocabulary:

| Status | Meaning |
|---|---|
| **MERGED** | present on `develop` |
| **DRAFT** | implemented on an open draft PR; **not on `develop`** |
| **PARTIAL LIVE** | a specific, receipted DEV behaviour exists; full criterion not accepted |
| **CODE** | implemented; automated evidence; no live acceptance |
| **BLOCKED** | cannot be exercised without owner configuration or consent |
| **PENDING** | not yet executed or not yet verifiable |

## 3. Traceability matrix

`R` = release criterion in `doc/v0.2/RELEASE-DOSSIER.html`. "Merge state" is the
state of the implementation named in the row, not the state of the whole v0.2
feature set.

| R | Requirement | Code | Merge state | Automated evidence | Live evidence | Status | Next action |
|---|---|---|---|---|---|---|---|
| R01 | Owner login | `convex/auth.ts`, `auth.config.ts`, `OwnerDashboard` | MERGED (#1, #2, #6, #7, #34) | `auth.test.ts`, `authz.test.ts`, `owner-gate.test.tsx`, `e2e/owner-auth.spec.ts` | sign-in reported at the earlier baseline; **not re-verified** | CODE | owner signs in once |
| R02 | T3 connect + native OAuth | `t3OAuth.ts`, `/api/t3/oauth/start`, `/api/t3/callback` | MERGED (#23, #33, #34) | `t3OAuthStart.test.ts`, `t3OAuthCallback.test.ts`, `t3OAuthCallbackSafety.test.ts`, `t3Sanitization.test.ts` | **Operate OAuth consent succeeded** and a **real T3 environment with 19 projects** was discovered on DEV (baseline receipt) | **PARTIAL LIVE** — connect + operate consent + project discovery observed; full read/refresh/revoke acceptance and R01–R12 DEV acceptance remain PENDING | complete the DEV acceptance run |
| R03 | Linear OAuth | `linearOAuth.ts`, `/api/linear/oauth/start`, `/api/linear/callback` | MERGED (#9) | `linearOAuth.test.ts`, `linearConnectionsStore.test.ts` | none | BLOCKED — config/consent not verified | owner configures Linear app + consent |
| R04 | Project mappings | `projectMappings.ts`, `MappingsPanel` | MERGED (#11) | `projectMappings.test.ts`, `mappings.test.ts`, `mappingsPanel.test.tsx` | none | BLOCKED — needs R03 | owner maps one project |
| R05 | Browse Linear issues | `linearIssues.ts`, `IssuesPanel` | MERGED (#12) | `linearIssues.test.ts`, `issues.test.tsx` | none | BLOCKED — needs R03/R04 | browse after R04 |
| R06 | Editable launch prompt | `execute/ExecutePanel.tsx`, `execute/prompt.ts` | MERGED panel; mount **DRAFT** (#36) | `ExecutePanel.test.tsx`, `prompt.test.ts`, mounted-flow browser suite | none | CODE (merge state: **DRAFT**) | merge #36, then live review |
| R07 | Model selection | `ExecutePanel`, preflight catalog | MERGED panel; mount **DRAFT** (#36) | `ExecutePanel.test.tsx`, preflight decode tests | none | CODE (merge state: **DRAFT**) | merge #36 |
| R08 | Native worktree launch | `t3Launch.ts`, `/api/t3/launch` | MERGED; destination gate **DRAFT** (#35) | `t3Launch.test.ts`, `t3LaunchRecover.test.ts`, `launchStaleRecovery.test.ts`, `writeTargetPolicy.test.ts` | none (no write performed) | CODE; destination **not provable on `develop` until #35 merges** | merge #35 + approve write target |
| R09 | Thread ↔ issue association | `linearAssociation.ts`, `ManualLinkControl` | MERGED (#25–#27) | `linearAssociation.test.ts`, `linearManualLink.test.ts`, `manual-link.spec.ts` | none | CODE | needs R08 for launch-created bindings |
| R10 | Linear In Progress sync | `linearSync.ts`, `crons.ts`, `linearSyncStore.ts` | MERGED (#25, #29 incl. #28) | `linearSync.test.ts`, `linearSyncTrigger.test.ts`, `linearSyncLaunchTrigger.test.ts`, `cronGuard.test.ts` | none | CODE | needs R03 + R08 |
| R11 | Follow-up / interrupt | `t3Send.ts`, `t3Interrupt.ts`, `t3Attention.ts` | MERGED; destination gate **DRAFT** (#35) | `t3Send.test.ts`, `t3Interrupt.test.ts`, `t3Attention.test.ts`, `followup.spec.ts`, `interrupt.spec.ts` | none | CODE; gate **DRAFT** | merge #35 + owner approval |
| R12 | Link / attention / PR visibility | `linearManualLink`, `t3Attention`, `verifiedPullRequest` | MERGED (#24, #27) | `verifiedPullRequest.test.ts`, `verifiedPullRequest.spec.ts` | none | CODE; needs `GITHUB_TOKEN` + `HELM_GITHUB_REPOSITORY` | owner configures read-only GitHub |

**Summary, stated without contradiction:**

- The only live-verified T3 behaviour is **Operate OAuth consent plus real
  environment/project discovery** (R02, partial). It is not proof of a full
  connect lifecycle, of Linear, or of any native write.
- **Full R01–R12 DEV acceptance is PENDING.** No criterion is fully accepted.
- #35 (write gate) and #36 (mounted UI) are **drafts**. On `develop` today the
  native write destination is still unprovable and the execution review is
  still unmounted. Reading this matrix as "shipped" would be wrong until those
  merge.

## 4. Findings that changed the plan

### 4.1 Native write destination was not owner-approvable (P0) — DRAFT #35

`t3Launch`, `t3Send` and `t3Interrupt` call `operateToolCall(secret.endpoint, …)`.
The endpoint comes from the saved `operate` OAuth grant. Enforced on `develop`
today:

- endpoint is HTTPS on a trusted `*.t3coderelay.com` host (`t3OAuth.safeFetch`);
- the grant is `access: "operate"` and `status: "connected"` (`lib/operateGate`);
- `mapping.t3EnvironmentId === grant.environmentId` (launch);
- the mapping's T3 project exists in that environment (`projectMappings.save`);
- the token is AAD-bound to owner + endpoint.

Missing on `develop`: an explicit statement of **which destination the owner
approved for writes**. `T3_MCP_URL_ISOLATED` does not cover this; it is read
only by `convex/dispatch.ts`, a different transport.

Draft PR #35 adds `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS`,
required and fail-closed, checked before any network call. Unconfigured
deployments refuse native writes. Empty entries in the allowlist
(`env-a,,env-b`) reject the whole list. Detail:
`doc/v0.2/native-write-target.md` (lands with #35).

### 4.2 The execution review was never mounted (P1) — DRAFT #36

`ExecutePanel` was complete and tested, but `OwnerDashboard` mounted only the T3
workspace, mappings and issue browser; there was no product route from an issue
to a launch. Draft #36 mounts it through the existing issue browser, matches the
mapping on the detail's read-time project and the issue's authoritative team,
drops superseded detail reads, and guards launches synchronously against
same-task double clicks.

### 4.3 PR reconciliation

| PR | State | Evidence | Conclusion |
|---|---|---|---|
| #3 | Open, base `integrate/ega-677-678-foundation` | Its modules (`convex/projects.ts`, `connections.ts`, `lib/targets.ts`, `lib/projectConnectionAdapters.ts`, `src/app/projectStatus.ts`) are **absent** from `develop` | Not incorporated. Older isolated-dispatcher design superseded by `t3ConnectionsStore` + `linearProjectMappings`. Do **not** merge wholesale. |
| #4 | Open, same base | Its frontend files exist on `develop` | Superseded in substance; nothing to integrate. |
| #5 | Open, same base | Its backend files exist on `develop` | Superseded in substance; nothing to integrate. |
| #28 | Closed without direct merge | Its files are present on `develop` | Functionally incorporated through #29. |

No PR was closed, merged, or modified in this pass.

### 4.4 Documentation drift (P2) — addressed here

`OWNER-ACTIONS.md` was written against `develop bc1fee8` and states that PRs
#8–#13 are open and that DEV has no T3 grant. The release dossier's original
R01–R12 table shows every criterion PENDING and predates the #34 consent
receipts. The documents now carry dated current-state sections; historical
tables are preserved.

### 4.5 "Connection error: Unknown" (P3) — fixed in #37

`MetadataRow` rendered `value ?? "Unknown"`, so a healthy connected grant with no
error code claimed an unknown error. The row now distinguishes a confirmed code
(verbatim), `None — no current error` (connected), and `Not reported by the
backend` (non-connected, no code). `ui.ts: connectionErrorLabel`; helper and
rendered-row tests.

### 4.6 Read-only / operate coexistence

Code supports both rows (`listConnections`, `resolveOperateConnection` filters by
access). The DEV screenshot at baseline showed **one** Operate row. Two-row live
coexistence remains unproven. No connection was recreated to manufacture a
second row.

### 4.7 `Linear connection is unavailable` — what it actually means

Observed earlier from `/api/linear/mappings/candidates`. The message has exactly
one producer:

```
convex/projectMappings.ts:81
  if (connections.length === 0) throw new Error("Linear connection is unavailable");
```

The runtime cause is **zero saved Linear connections for the owner**, not a bad
token, a workspace mismatch, or a failed refresh — those have distinct messages
(`expired`, `reauthorizationRequired`, workspace identity changed). Missing
OAuth *configuration* is an earlier failure in `linearOAuth.start`.

Classification procedure (needs DEV access, no secret values):

1. confirm presence (not value) of `LINEAR_CLIENT_ID`,
   `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`,
   `HELM_APP_URL` on DEV Convex;
2. confirm the Linear redirect URI is exactly
   `https://dev-helm.egawilldoit.online/api/linear/callback`
   (`convex/lib/linearHelpers.ts: linearCallbackUri`);
3. check whether a `linearConnections` row exists for the owner;
4. only if a row exists, inspect its `status`/`lastErrorCode`;
5. only if connected, run one candidates read.

Until steps 1–3 succeed, R03–R05 are **BLOCKED**, not defective. The legacy
`LINEAR_API_KEY` path and the ChatGPT Linear integration are not proof that
Helm's OAuth connection works.

### 4.8 Security patch prepared, not merged (#38, #39)

`next@16.4.0` is affected by GHSA-2464-fhr4-w9xw (critical), GHSA-673q-mjm6-r5xr
(critical) and GHSA-p3m5-59mp-jv5r (high). Both patch PRs bump `next` and
`eslint-config-next` to **16.4.2** only:

| PR | Branch | Head | State |
|---|---|---|---|
| #38 | `security/next-16.4.2` → `develop` | `04aa9ea` | draft, CI green, not merged |
| #39 | `security/next-16.4.2-main` → `main` | `215611b` | draft, CI green, not merged |

Verified on both: a single 16.4.2 Next copy (including the `@clerk/nextjs`
peer), zero `next` advisories in `pnpm audit`, and a first-attempt build.
Residual, deliberately untouched: dev-only `braces` (high) and MCP-SDK
`ip-address` (moderate). `doc/security/next-16.4.2.md` is byte-identical on both
branches (it lands with #38/#39 and is not on `develop` yet), so the next
`develop → main` merge has no add/add conflict.

**`develop` and `main` still pin 16.4.0.** Production security patching is a
separate owner decision from the v0.2 release.

### 4.9 Combined-integration verification requirements

The five PRs are independent drafts based on `b85a8e3`. #38 changes the
lockfile; merging it moves `develop` and makes every other PR head stale. The
required sequence is:

1. merge **#38** to `develop` after owner approval;
2. sync each of **#35 → #36 → #37** with the new `develop` (`git merge
   origin/develop`, no force-push needed), then re-run each PR's full gates;
3. re-run a combined verification on the final stack — backend, frontend unit,
   browser, typecheck, lint, build — because #36 and #37 both touch
   `Dashboard.tsx`/`dashboard.test.tsx`;
4. verify CI on each exact pushed head before merge.

A local pre-merge simulation (unpushed branch, order #38 → #35 → #36 → #37)
produced **zero conflicts**. Its gates are recorded in §5. That simulation is
evidence of mergeability, not a substitute for step 3 on the final heads.

## 5. Verification performed

| Gate | Result | Where |
|---|---|---|
| Backend `pnpm test` | 725 passed / 42 files | baseline `develop` / #36 |
| Backend `pnpm test` | 758 passed / 43 files (+33 write-target tests) | #35 `38c6242` |
| Frontend `pnpm run test:frontend` | 403 passed / 27 files | #36 `1bb2cbe` |
| Frontend `pnpm run test:frontend` | 404 passed / 28 files | #37 |
| Browser `pnpm run test:frontend:browser` | **93 passed** (83 baseline + 10 mounted-flow) | #36 `1bb2cbe` |
| `pnpm run typecheck` | passed | all worktrees |
| `pnpm run lint` | 0 errors, 1 pre-existing warning (`postcss.config.mjs`) | all worktrees |
| `pnpm run build` | passed; on unpatched `develop` the Next.js advisory nudge may require one retry, on 16.4.2 it passes first attempt | as noted per branch |
| Combined simulation | 758 backend / 408 frontend / **93 browser**; typecheck, lint 0 errors, build first attempt; zero conflicts | local, unpushed |

**Every browser result uses stubbed `/api/*` routes.** They prove client
behaviour, not live DEV acceptance, and not live Convex/T3 connectivity.

The two previously PENDING EGA-767 cases have browser regression coverage on the
**mounted** interface (draft #36): lost acknowledgement across a full reload,
and two tabs racing one issue. Both use real Playwright pages against a stub
server; they are not hosted acceptance.

## 6. Live state that was *not* verified

- No live T3 native write was performed.
- Linear OAuth configuration and consent on DEV were not verified; the earlier
  `Linear connection is unavailable` is classified in §4.7 but not reproduced
  with DEV presence checks.
- DEV Vercel + Convex revisions were not re-deployed or re-inspected; the
  baseline receipt (Vercel at `b85a8e3`, Convex sync, operate consent, 19
  projects) is historical, not current truth.
- No Linear issue status was changed and no GitHub PR was created, approved or
  merged by Helm.

## 7. Owner-gated actions (priority order)

1. **Linear OAuth** — create the Linear app with redirect
   `https://dev-helm.egawilldoit.online/api/linear/callback`; set
   `LINEAR_CLIENT_ID` (and `LINEAR_CLIENT_SECRET` if confidential),
   `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION=v1`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`
   (32-byte base64) on DEV Convex. Sign in and complete one Linear consent.
2. **Disposable write-target authorization** — approve and set
   `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS` (lands with #35).
   Until then every native write refuses.
3. **Integration review** — merge #38, then #35 → #36 → #37 in order, re-running
   gates on each new head (§4.9).
4. **Explicit DEV deployment** — deploy the merged `develop` to the DEV Vercel
   project and sync DEV Convex; then run the signed acceptance sequence (map a
   project, browse issues, review, launch, follow-up, interrupt, Linear status,
   PR verification).
5. **Production security decision** — treat #39 as a separate approval. Merging
   it to `main` authorizes a Production release; do not couple it to v0.2.
6. **GitHub verification** — read-only `GITHUB_TOKEN`,
   `HELM_GITHUB_REPOSITORY`, optional `HELM_GITHUB_BASE_BRANCH`.

## 8. Release readiness

**CODE READY — DEV BLOCKED (drafts unmerged).**

- The P0/P1 gaps are fixed only on draft PRs #35/#36; until they merge,
  `develop` still lacks the write-target gate and the mounted UI.
- Full R01–R12 DEV acceptance is PENDING. Only T3 Operate OAuth and real
  project discovery are partially live verified.
- DEV acceptance is blocked on owner configuration/consent and an approved
  disposable write target, not on missing code.
- `develop` remains on Next.js 16.4.0 until #38 merges; `main` remains on
  16.4.0 until #39 is separately approved.
- Production promotion (EGA-768) remains **HOLD**.
