# Helm v0.2 — reconciled current state

Date: **2026-10-23** (post-merge revision)
This document supersedes the operational conclusions in older v0.2 reports. It
does not overwrite their historical evidence; where a claim is historical, it is
marked as such.

## 1. Repository state at this revision

| Fact | Value |
|---|---|
| `origin/develop` | `3ce5d87c189fd3a74de7ef4125b5b566869e04eb` (#35 + #36 merged on top of the #38 security patch) |
| `origin/main` | `d17c4f575f04af111fe8b172fc7f2e046dbead27` (v0.1 + the security-only #39 patch) |
| Next.js on both branches | **16.4.2** (#38 / #39) |
| DEV frontend | `https://dev-helm.egawilldoit.online` |
| DEV Convex | `dev:hardy-warthog-60` |
| Production | v0.1 + Next.js 16.4.2 only; **v0.2 is not promoted**; EGA-768 HOLD |

Merged in this cycle, with merge commits:

| PR | Scope | Merge commit |
|---|---|---|
| #38 | Next.js 16.4.2 security patch → `develop` | `cf63be4` |
| #39 | Next.js 16.4.2 security patch → `main` | `d17c4f5` |
| #35 | Native write-target safety → `develop` | `5ce9115` |
| #36 | Mounted execution review + recovery ordering → `develop` | `3ce5d87` |
| #37 | This documentation revision | the commit that closes this PR |

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
| **PARTIAL LIVE** | a specific, receipted DEV behaviour exists; full criterion not accepted |
| **CODE** | implemented; automated evidence; no live acceptance |
| **BLOCKED** | cannot be exercised without owner configuration or consent |
| **PENDING** | not yet executed or not yet verifiable |

## 3. Traceability matrix

`R` = release criterion in `doc/v0.2/RELEASE-DOSSIER.html`.

| R | Requirement | Code | Merge state | Automated evidence | Live evidence | Status | Next action |
|---|---|---|---|---|---|---|---|
| R01 | Owner login | `convex/auth.ts`, `auth.config.ts`, `OwnerDashboard` | MERGED (#1, #2, #6, #7, #34) | `auth.test.ts`, `authz.test.ts`, `owner-gate.test.tsx`, `e2e/owner-auth.spec.ts` | sign-in reported at the earlier baseline; **not re-verified** | CODE | owner signs in once |
| R02 | T3 connect + native OAuth | `t3OAuth.ts`, `/api/t3/oauth/start`, `/api/t3/callback` | MERGED (#23, #33, #34) | `t3OAuthStart.test.ts`, `t3OAuthCallback.test.ts`, `t3OAuthCallbackSafety.test.ts`, `t3Sanitization.test.ts` | **Operate OAuth consent succeeded** and a **real T3 environment with 19 projects** was discovered on DEV (baseline receipt) | **PARTIAL LIVE** — connect + operate consent + project discovery observed; full read/refresh/revoke acceptance remains PENDING | complete the DEV acceptance run |
| R03 | Linear OAuth | `linearOAuth.ts`, `/api/linear/oauth/start`, `/api/linear/callback` | MERGED (#9) | `linearOAuth.test.ts`, `linearConnectionsStore.test.ts` | none | BLOCKED — config/consent not verified | owner configures Linear app + consent |
| R04 | Project mappings | `projectMappings.ts`, `MappingsPanel` | MERGED (#11) | `projectMappings.test.ts`, `mappings.test.ts`, `mappingsPanel.test.tsx` | none | BLOCKED — needs R03 | owner maps one project |
| R05 | Browse Linear issues | `linearIssues.ts`, `IssuesPanel` | MERGED (#12) | `linearIssues.test.ts`, `issues.test.tsx` | none | BLOCKED — needs R03/R04 | browse after R04 |
| R06 | Editable launch prompt | `execute/ExecutePanel.tsx`, `execute/prompt.ts`, `IssuesPanel` mount | MERGED (#13, mount #36) | `ExecutePanel.test.tsx`, `prompt.test.ts`, mounted-flow browser suite | none | CODE | live review |
| R07 | Model selection | `ExecutePanel`, preflight catalog | MERGED (#13, mount #36) | `ExecutePanel.test.tsx`, preflight decode tests | none | CODE | live review |
| R08 | Native worktree launch | `t3Launch.ts`, `/api/t3/launch`, `lib/writeTargetPolicy.ts` | MERGED (#16, gate #35) | `t3Launch.test.ts`, `t3LaunchRecover.test.ts`, `launchStaleRecovery.test.ts`, `writeTargetPolicy.test.ts` | none (no write performed) | CODE; **writes refuse until an approved target is configured** | approve write target |
| R09 | Thread ↔ issue association | `linearAssociation.ts`, `ManualLinkControl` | MERGED (#25–#27) | `linearAssociation.test.ts`, `linearManualLink.test.ts`, `manual-link.spec.ts` | none | CODE | needs R08 for launch-created bindings |
| R10 | Linear In Progress sync | `linearSync.ts`, `crons.ts`, `linearSyncStore.ts` | MERGED (#25, #29 incl. #28) | `linearSync.test.ts`, `linearSyncTrigger.test.ts`, `linearSyncLaunchTrigger.test.ts`, `cronGuard.test.ts` | none | CODE | needs R03 + R08 |
| R11 | Follow-up / interrupt | `t3Send.ts`, `t3Interrupt.ts`, `t3Attention.ts`, `lib/writeTargetPolicy.ts` | MERGED (#17–#21, gate #35) | `t3Send.test.ts`, `t3Interrupt.test.ts`, `t3Attention.test.ts`, `followup.spec.ts`, `interrupt.spec.ts` | none | CODE; gate merged | owner approval |
| R12 | Link / attention / PR visibility | `linearManualLink`, `t3Attention`, `verifiedPullRequest` | MERGED (#24, #27) | `verifiedPullRequest.test.ts`, `verifiedPullRequest.spec.ts` | none | CODE; needs `GITHUB_TOKEN` + `HELM_GITHUB_REPOSITORY` | owner configures read-only GitHub |

**Summary, stated without contradiction:**

- The only live-verified T3 behaviour is **Operate OAuth consent plus real
  environment/project discovery** (R02, partial). It is not proof of a full
  connect lifecycle, of Linear, or of any native write.
- **Full R01–R12 DEV acceptance is PENDING.** No criterion is fully accepted.
- Implementation for #35 (write-target gate) and #36 (mounted review) is now
  **merged to `develop`**. That is not DEV acceptance; it is code and automated
  evidence only.

## 4. Findings and their resolution

### 4.1 Native write destination was not owner-approvable (P0) — fixed, merged #35

`t3Launch`, `t3Send` and `t3Interrupt` call `operateToolCall(secret.endpoint, …)`
using the saved `operate` OAuth grant. Before #35, the enforced facts were the
trusted HTTPS host, operate access/status, the mapping's environment equality,
the mapping's live project read, and the token's owner+endpoint AAD. Missing was
an explicit statement of **which destination the owner approved for writes**;
`T3_MCP_URL_ISOLATED` governs only `convex/dispatch.ts`.

#35 adds `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS`, required
and fail-closed, checked before any outbound call. Empty comma entries reject the
whole list. The gate runs before launch's Linear and catalogue reads, before
send's thread read, and before interrupt's thread read; all three paths assert
zero connect/tool calls on refusal.

### 4.2 The execution review was never mounted (P1) — fixed, merged #36

`ExecutePanel` existed but was unreachable. #36 mounts it through the issue
browser, matches the mapping on the detail's read-time project and the issue's
authoritative team, drops superseded detail reads, and guards launches
synchronously against same-task double clicks.

A second audit found recovery reads were unordered: a slow older recovery could
land after a newer one. #36 now uses one monotonic recovery scope shared by the
initial read, every refresh and unmount, aborting predecessors; the
"Refresh prior executions" control is always available so a newer read can
deliberately supersede an in-flight one. A deterministic regression failed
before the guard (the older "none" replaced "Already launched") and passes now.
Server-side duplicate-launch guards are unchanged.

### 4.3 PR reconciliation

| PR | State | Evidence | Conclusion |
|---|---|---|---|
| #3 | Open, base `integrate/ega-677-678-foundation` | Its modules (`convex/projects.ts`, `connections.ts`, `lib/targets.ts`, `lib/projectConnectionAdapters.ts`, `src/app/projectStatus.ts`) are **absent** from `develop` | Not incorporated. Older isolated-dispatcher design superseded by `t3ConnectionsStore` + `linearProjectMappings`. Do **not** merge wholesale. |
| #4 | Open, same base | Its frontend files exist on `develop` | Superseded in substance; nothing to integrate. |
| #5 | Open, same base | Its backend files exist on `develop` | Superseded in substance; nothing to integrate. |
| #28 | Closed without direct merge | Its files are present on `develop` | Functionally incorporated through #29. |

### 4.4 Documentation drift (P2) — addressed by #37

`OWNER-ACTIONS.md` was written against `develop bc1fee8` and states that PRs
#8–#13 are open and that DEV has no T3 grant. The release dossier's original
R01–R12 table shows every criterion PENDING and predates the #34 consent
receipts. Historical sections are retained and labelled; current sections carry
the 2026-10-23 state.

### 4.5 "Connection error: Unknown" (P3) — fixed, merged #37

`MetadataRow` rendered `value ?? "Unknown"`, so a healthy connected grant with no
error code claimed an unknown error. The row distinguishes a confirmed code
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
token, a workspace mismatch, or a failed refresh — those have distinct messages.
Missing OAuth *configuration* is an earlier failure in `linearOAuth.start`.

Classification procedure (needs DEV access, no secret values):

1. confirm presence (not value) of `LINEAR_CLIENT_ID`,
   `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1`,
   `HELM_APP_URL` on DEV Convex;
2. confirm the Linear redirect URI is exactly
   `https://dev-helm.egawilldoit.online/api/linear/callback`;
3. check whether a `linearConnections` row exists for the owner;
4. only if a row exists, inspect its `status`/`lastErrorCode`;
5. only if connected, run one candidates read.

Until steps 1–3 succeed, R03–R05 are **BLOCKED**, not defective. The legacy
`LINEAR_API_KEY` path and the ChatGPT Linear integration are not proof that
Helm's OAuth connection works.

### 4.8 Security patch — merged (#38, #39)

| PR | Target | Merge commit | Result |
|---|---|---|---|
| #38 | `develop` | `cf63be4` | Next.js 16.4.2; zero `next` advisories |
| #39 | `main` | `d17c4f5` | Next.js 16.4.2; security-only Production patch |

Affected-version ranges establish exposure in principle, not a proven exploit.
Checked at patch time: `sharp@0.35.5` already met the image advisory's documented
workaround; no `"use cache"` directive existed; no `"use server"` directive
existed (the Server Actions advisory excludes such apps). The patch is defense in
depth. Residual advisories remain out of scope: dev-only `braces@3.0.3` (high)
and MCP-SDK `ip-address@10.7.3` (moderate). `doc/security/next-16.4.2.md` records
the details; it is byte-identical on both branches.

### 4.9 Combined-integration verification

Merged order: #38 → #35 → #36. Each PR was synchronized with the then-current
`develop`, gates were re-run locally, CI passed on the exact pushed head, and
the merge result was read back. #37 is synchronized last.

Remaining verification: **hosted DEV acceptance** — the owner-gated sequence in
§7 — which no local or CI run can substitute for.

## 5. Verification performed

| Gate | Result | Where |
|---|---|---|
| Backend `pnpm test` | **758 passed / 43 files** | `develop` after #35/#36 (and #37 branch) |
| Frontend `pnpm run test:frontend` | **408 passed / 28 files** | #37 branch (contains #36 + #37 tests) |
| Browser `pnpm run test:frontend:browser` | **94 passed** (83 baseline + 11 mounted-flow) | #37 branch |
| `pnpm run typecheck` | passed | all branches |
| `pnpm run lint` | 0 errors, 1 pre-existing warning (`postcss.config.mjs`) | all branches |
| `pnpm run build` | passed on the first attempt (Next.js 16.4.2) | all branches |
| Security audit | zero `next` advisories | #38 / #39 |
| `git diff --check` | clean | all branches |

**Every browser result uses stubbed `/api/*` routes and real Playwright pages.**
They prove client behaviour; they are not hosted Convex/T3 acceptance.

The two EGA-767 browser regressions (lost acknowledgement across reload; two tabs
racing one issue) run on the **merged** mounted interface. They are harness
evidence, not mutation-proven and not hosted acceptance.

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
   `LINEAR_CLIENT_ID`, `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION=v1`,
   `LINEAR_OAUTH_ENCRYPTION_KEY_V1` (32-byte base64), and
   `LINEAR_CLIENT_SECRET` only if confidential. Sign in and complete one Linear
   consent.
2. **Disposable write-target authorization** — set
   `T3_NATIVE_WRITE_ENDPOINT` + `T3_NATIVE_WRITE_ENVIRONMENTS` to a disposable
   T3 instance and its environment id. Until then every native write refuses.
   Do **not** rotate the working `T3_OAUTH_ENCRYPTION_KEY_V1`: replacing it
   invalidates existing ciphertext. The earlier "replace the key" instruction is
   historical.
3. **Explicit DEV deployment** — deploy the merged `develop` to the DEV Vercel
   project and sync DEV Convex; merging does not deploy.
4. **Acceptance run** — sign in, map one Linear project/team to the approved T3
   project (started state, base ref, target branch), then exercise review →
   launch → follow-up → interrupt → Linear status → PR verification.
5. **GitHub verification** — read-only `GITHUB_TOKEN` plus
   `HELM_GITHUB_REPOSITORY` (optional `HELM_GITHUB_BASE_BRANCH`).
6. **Production** — #39 already delivered the security-only `main` patch.
   Promoting v0.2 remains a separate decision; EGA-768 is HOLD.

## 8. Release readiness

**CODE MERGED — DEV ACCEPTANCE BLOCKED.**

- The write-target gate and mounted execution review are on `develop`; the
  security patch is on both branches.
- Full R01–R12 DEV acceptance is PENDING. Only T3 Operate OAuth and real project
  discovery are partially live verified.
- Remaining blockers are owner configuration/consent, an explicitly approved
  disposable write target, and an explicit DEV deployment — not missing code.
- v0.2 is **not** promoted to `main`; EGA-768 remains HOLD.
