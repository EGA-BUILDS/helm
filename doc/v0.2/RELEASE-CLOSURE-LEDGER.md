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

## 6. Resume point

Next exact actions, in order:

1. Push `2652bb5` (EGA-766 wiring + this ledger) to the integration branch; verify CI on PR #21.
2. Dispatch implementation for **B3** (EGA-762 product sync trigger) and **B4** (EGA-763 Dashboard UI).
3. Phase C: independent review of the complete integrated implementation.
4. Phase D: integrate one PR at a time into `develop` in the safe order — **#21 first** (it is the only
   place the 764/765 guard conflict is resolved), then #24, #25, #26, #22, then the restacked #23.
5. Phase F: EGA-767 reliability certification on the integrated candidate.
6. Phase E/G: hosted DEV acceptance — gated on owner actions 1–7.
7. Phase H: GO/NO-GO. **Do not merge to `main`. Do not promote Production.**
