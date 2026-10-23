# Helm v0.2 — reconciled current state

Date: **2026-10-23**
This document supersedes the operational conclusions in older v0.2 reports. It
does not overwrite their historical evidence; where a claim is historical, it is
marked as such.

## 1. Baseline at the start of this pass

| Fact | Value |
|---|---|
| `origin/develop` | `b85a8e3010d5c85b0b0b8f25709f6140901bc132` (unchanged since PR #34) |
| `origin/main` | `0e863c410cf5b0eba438d0e656794fce366880b6` (v0.1) |
| Open PRs before this pass | #3, #4, #5 — all against `integrate/ega-677-678-foundation` |
| Latest merged PR | #34 — T3 OAuth consent guidance (2026-10-22) |
| DEV frontend | `https://dev-helm.egawilldoit.online` |
| DEV Convex | `dev:hardy-warthog-60` |
| Production | `main` only; EGA-768 remains HOLD |

Working tree had one untracked file (`doc/ORCHESTRATION_REPORT.md`), preserved in
the primary checkout. All work in this pass was done in isolated worktrees.

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

Status vocabulary used below:

| Status | Meaning |
|---|---|
| **LIVE** | observed working in DEV, with a dated receipt |
| **CODE** | implemented; automated tests pass; no live acceptance |
| **UNMOUNTED** | implemented but not reachable from the product UI (at baseline) |
| **BLOCKED** | cannot be exercised without owner configuration or consent |
| **DEFECT** | reproduced, with evidence |
| **DEFERRED** | deliberately out of scope |

## 3. Traceability matrix

`R` = release criterion in `doc/v0.2/RELEASE-DOSSIER.html`.

| R | Requirement | Current code | Automated evidence | Merged PR | Live proof | Status at baseline | Next action |
|---|---|---|---|---|---|---|---|
| R01 | Owner login | `convex/auth.ts`, `auth.config.ts`, `OwnerDashboard` | `auth.test.ts`, `authz.test.ts`, `owner-gate.test.tsx`, `e2e/owner-auth.spec.ts` | #1, #2, #6, #7, #34 | DEV sign-in reported at baseline; not re-verified | CODE | owner signs in once |
| R02 | T3 connect + native OAuth | `t3OAuth.ts`, `/api/t3/oauth/start`, `/api/t3/callback` | `t3OAuthStart.test.ts`, `t3OAuthCallback.test.ts`, `t3OAuthCallbackSafety.test.ts`, `t3Sanitization.test.ts` | #23, #33, #34 | Live operate consent succeeded; real environment and 19 projects observed (baseline report) | LIVE (read+operate grant) | none |
| R03 | Linear OAuth | `linearOAuth.ts`, `/api/linear/oauth/start`, `/api/linear/callback` | `linearOAuth.test.ts`, `linearConnectionsStore.test.ts` | #9 | None | BLOCKED — config/consent not verified in this pass | owner configures Linear app + consent |
| R04 | Project mappings | `projectMappings.ts`, `MappingsPanel` | `projectMappings.test.ts`, `mappings.test.ts`, `mappingsPanel.test.tsx` | #11 | None | BLOCKED — needs R03 | owner maps one project |
| R05 | Browse Linear issues | `linearIssues.ts`, `IssuesPanel` | `linearIssues.test.ts`, `issues.test.tsx` | #12 | None | BLOCKED — needs R03/R04 | owner browses after R04 |
| R06 | Editable launch prompt | `execute/ExecutePanel.tsx`, `execute/prompt.ts` | `ExecutePanel.test.tsx`, `prompt.test.ts` | #13 | None | **UNMOUNTED** → fixed by #36 | deployed in #36 |
| R07 | Model selection | `ExecutePanel`, preflight catalog | `ExecutePanel.test.tsx`, `preflight` decode tests | #13 | None | UNMOUNTED → fixed by #36 | same |
| R08 | Native worktree launch | `t3Launch.ts`, `/api/t3/launch` | `t3Launch.test.ts`, `t3LaunchRecover.test.ts`, `launchStaleRecovery.test.ts` | #16 | None (no write performed) | CODE + **destination unproven** → gate added in #35 | owner approves write target |
| R09 | Thread ↔ issue association | `linearAssociation.ts`, `ManualLinkControl` | `linearAssociation.test.ts`, `linearManualLink.test.ts`, `manual-link.spec.ts` | #25, #26, #27 | None | CODE | needs R08 for launch-created bindings |
| R10 | Linear In Progress sync | `linearSync.ts`, `crons.ts`, `linearSyncStore.ts` | `linearSync.test.ts`, `linearSyncTrigger.test.ts`, `linearSyncLaunchTrigger.test.ts`, `cronGuard.test.ts` | #25, #29 (incl. #28's content) | None | CODE | needs R03 + R08 |
| R11 | Follow-up / interrupt | `t3Send.ts`, `t3Interrupt.ts`, `t3Attention.ts` | `t3Send.test.ts`, `t3Interrupt.test.ts`, `t3Attention.test.ts`, `followup.spec.ts`, `interrupt.spec.ts` | #17–#21 | None | CODE + destination gate in #35 | owner approval |
| R12 | Link / attention / PR visibility | `linearManualLink`, `t3Attention`, `verifiedPullRequest` | `verifiedPullRequest.test.ts`, `verifiedPullRequest.spec.ts` | #24, #27 | None | CODE; PR verification needs `GITHUB_TOKEN` + `HELM_GITHUB_REPOSITORY` | owner configures read-only GitHub |

Every requirement has implementation and automated evidence. **None is LIVE
accepted for v0.2**, because the DEV configuration and consents required for
R03/R04/R05 have not been verified in this pass and R08/R11 require an approved
write destination.

## 4. Findings that changed the plan

### 4.1 Native write destination was not owner-approvable (P0) — fixed in #35

`t3Launch`, `t3Send` and `t3Interrupt` call `operateToolCall(secret.endpoint, …)`.
The endpoint comes from the saved `operate` OAuth grant. Before this pass the
enforced facts were:

- endpoint is HTTPS on a trusted `*.t3coderelay.com` host (`t3OAuth.safeFetch`);
- the grant is `access: "operate"` and `status: "connected"` (`lib/operateGate`);
- `mapping.t3EnvironmentId === grant.environmentId` (launch);
- the mapping's T3 project exists in that environment (`projectMappings.save`);
- the token is AAD-bound to owner + endpoint.

Missing: an explicit statement of **which destination the owner approved for
writes**. `T3_MCP_URL_ISOLATED` does not cover this: it is read only by
`convex/dispatch.ts`, a different transport.

PR #35 adds `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS`,
required and fail-closed, checked before any network call. Unconfigured
deployments refuse native writes. Detail: `doc/v0.2/native-write-target.md`.

### 4.2 The execution review was never mounted (P1) — fixed in #36

`ExecutePanel` was complete and tested but `OwnerDashboard` mounted only the T3
workspace, mappings and issue browser. There was no product route from an issue
to a launch. PR #36 mounts it through the existing issue browser, matches the
mapping on the detail's read-time project and the issue's authoritative team,
and drops superseded detail reads.

### 4.3 PR reconciliation

| PR | State | Evidence | Conclusion |
|---|---|---|---|
| #3 | Open, base `integrate/ega-677-678-foundation` | Its modules (`convex/projects.ts`, `connections.ts`, `lib/targets.ts`, `lib/projectConnectionAdapters.ts`, `src/app/projectStatus.ts`) are **absent** from `develop` | Not incorporated. It is an older isolated-dispatcher design, superseded by `t3ConnectionsStore` + `linearProjectMappings`. Do **not** merge wholesale; recommend closing after owner review, salvaging only genuinely reusable pure helpers if still wanted. |
| #4 | Open, same base | Its frontend files exist on `develop` (`Dashboard.tsx`, `contract.ts`, `ui.ts`, harnesses) | Superseded in substance; nothing to integrate. |
| #5 | Open, same base | Its backend files exist on `develop` (`t3OAuth.ts`, `t3ConnectionsStore.ts`, all `/api/t3/*` routes) | Superseded in substance; nothing to integrate. |
| #28 | Closed without direct merge | Its files (`linearSync.ts`, `linearSyncStore.ts`, `linearSyncTrigger.test.ts`, `crons.ts`) are present on `develop` | Functionally incorporated through #29. No follow-up work required. |

No PR was closed, merged, or modified in this pass.

### 4.4 Documentation drift (P2) — addressed here

`doc/v0.2/OWNER-ACTIONS.md` was written against `develop bc1fee8` and states that
PRs #8–#13 are open and that DEV has no T3 grant. Both are historical. The
release dossier's R01–R12 table still shows every criterion PENDING and claims
"DEV has zero mappings" and "dispatch disabled", without the later #34 consent
receipts. Both documents now carry dated current-state sections.

### 4.5 "Connection error: Unknown" (P3) — fixed here

`MetadataRow` rendered `value ?? "Unknown"`, so a healthy connected grant with no
error code claimed an unknown error. The row now distinguishes:

- confirmed backend code (rendered verbatim);
- `None — no current error` for a connected grant;
- `Not reported by the backend` for a non-connected grant without a code.

`src/features/t3/ui.ts: connectionErrorLabel`, tests in `ui.test.ts`.

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

So the runtime cause is **zero saved Linear connections for the owner**, not a
bad token, a workspace mismatch, or a failed refresh — those have their own
distinct messages (`expired`, `reauthorizationRequired`, workspace identity
changed, etc.). Missing OAuth *configuration* is a different, earlier failure:
`linearOAuth.start` refuses before a consent can be attempted, which is one way
to end up with zero rows.

Classification procedure (needs DEV access, no secret values):

1. confirm presence (not value) of `LINEAR_CLIENT_ID`,
   `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`,
   `HELM_APP_URL` on the DEV Convex deployment;
2. confirm the Linear app's redirect URI is exactly
   `https://dev-helm.egawilldoit.online/api/linear/callback`
   (`convex/lib/linearHelpers.ts: linearCallbackUri`);
3. check whether a `linearConnections` row exists for the owner;
4. only if a row exists, inspect its `status`/`lastErrorCode`;
5. only if a row exists and is connected, run a single candidates read.

Until steps 1–3 succeed, R03–R05 are **BLOCKED**, not defective. The legacy
`LINEAR_API_KEY` and the older `/api/linear` server-side path are a *different*
code path and must not be treated as proof that Helm's OAuth connection works.

### 4.8 Prepared security patch (not merged)

`next@16.4.0` is affected by GHSA-2464-fhr4-w9xw (critical),
GHSA-673q-mjm6-r5xr (critical) and GHSA-p3m5-59mp-jv5r (high). Two
security-only draft PRs bump `next` and `eslint-config-next` to `16.4.2`:

- **#38** against `develop`;
- **#39** against `main` (Production branch).

Both are patch-only (two package versions + lockfile), verified to resolve a
single 16.4.2 Next copy, and build on the first attempt without the prior
advisory-gate retry. Neither is merged or deployed. See
`doc/security/next-16.4.2.md` (on the security branches) for the advisory
table and the two residual, deliberately untouched transitive advisories
(dev-only `braces`, MCP-SDK `ip-address`).

## 5. Verification performed in this pass

| Gate | Result | Where |
|---|---|---|
| Backend `pnpm test` | 725 passed / 42 files (baseline `develop`) | #36 worktree |
| Backend `pnpm test` | 758 passed / 43 files (+33 write-target tests) | #35 head `38c6242` |
| Frontend `pnpm run test:frontend` | 403 passed / 27 files | #36 worktree |
| Frontend `pnpm run test:frontend` | 403 passed / 28 files (+4 error-label tests) | #37 worktree |
| Browser `pnpm run test:frontend:browser` | 91 passed (83 baseline + 8 mounted-flow) | #36 head `6a98642` |
| `pnpm run typecheck` | passed | all worktrees |
| `pnpm run lint` | 0 errors, 1 pre-existing warning (`postcss.config.mjs`) | all worktrees |
| `pnpm run build` | passed (one retry past a Next.js security-advisory nudge; the prepared 16.4.2 patch removes the nudge) | #36 worktree |
| `git diff --check` | clean | all worktrees |

**Every browser result above uses stubbed `/api/*` routes.** They prove client
behaviour, not live DEV acceptance. Live acceptance still requires the owner
actions in §7; no criterion is rated LIVE from a harness run.

The two previously PENDING EGA-767 cases now have browser-level regression tests
on the **mounted** interface (draft PR #36): lost acknowledgement across a full reload,
and two tabs racing one issue.

## 6. Live state that was *not* verified in this pass

- No live T3 native write was performed.
- Linear OAuth configuration and consent on DEV were not verified; the failure
  observed earlier (`Linear connection is unavailable` from
  `/api/linear/mappings/candidates`) can only be classified with access to the
  DEV deployment's presence checks and an owner consent.
- DEV Vercel + Convex revision were not re-deployed or re-inspected; the
  baseline receipt (Vercel at `b85a8e3`, Convex sync succeeded, operate consent
  succeeded, 19 projects) is treated as historical, not current truth.
- No Linear issue status was changed and no GitHub PR was created, approved or
  merged by Helm during this pass.

## 7. Owner-gated actions

1. **Approve and configure the native write target** on DEV Convex:
   `T3_NATIVE_WRITE_ENDPOINT`, `T3_NATIVE_WRITE_ENVIRONMENTS`
   (`doc/v0.2/native-write-target.md`). Until then every native write refuses.
2. **Linear OAuth**: create the Linear app with redirect
   `https://dev-helm.egawilldoit.online/api/linear/callback`, set
   `LINEAR_CLIENT_ID` (and `LINEAR_CLIENT_SECRET` if confidential),
   `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION=v1`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`
   (32-byte base64).
3. **Sign in** to DEV as the owner, complete one T3 operate consent and one
   Linear consent.
4. **Map one Linear project/team** to the approved T3 project, including the
   started workflow state, base ref and target branch.
5. **Approve the disposable write acceptance** (one launch, one follow-up, one
   interrupt) against that approved target.
6. **GitHub verification**: set a read-only `GITHUB_TOKEN`,
   `HELM_GITHUB_REPOSITORY` and, if needed, `HELM_GITHUB_BASE_BRANCH`.

## 8. Release readiness

**CODE READY — DEV BLOCKED.**

- Both P0/P1 gaps identified in this pass are fixed with tests (#35, #36).
- Every v0.2 requirement has implementation and automated coverage.
- DEV acceptance is blocked on owner configuration/consent (steps 1–5 above),
  not on missing code.
- Production promotion (EGA-768) remains **HOLD** and is unchanged.
