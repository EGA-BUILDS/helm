# Helm

Helm is a private, owner-only orchestration workspace for [T3 Code](https://t3.codes).
It connects a Linear workspace to a native T3 environment so one owner can browse
real Linear issues, review an exact execution prompt, launch a native T3 worktree
thread, follow the run up, and see the resulting pull request — without a second
agent runtime or a second database.

Helm is not a general-purpose CI system, a multi-tenant product, or a replacement
for T3. It is the control surface between Linear and one owner's T3.

## What it does

| Capability | Surface |
|---|---|
| Owner-only sign-in (Clerk + Convex-verified owner subject) | `/` |
| Native T3 OAuth: read-only or operate consent, encrypted tokens | Connect T3 |
| T3 environments, projects, provider/model catalogue, threads, activity | T3 workspace |
| Linear OAuth, encrypted token storage, refresh/revoke lifecycle | Linear connection |
| Linear project → native T3 project mappings, per-team started state | Mappings panel |
| Browse/filter real Linear issues from mapped projects | Issue browser |
| Issue-driven execution review: editable prompt, model, preflight, explicit launch | Issue → *Prepare execution* |
| Durable launch attempts, reload recovery, no automatic relaunch | Execute review |
| Thread ↔ issue association, manual link/unlink/reassign | Thread panel |
| Safe Linear status sync with a team-scoped ledger | Background driver |
| Verified GitHub pull-request state, read-only | Thread panel |

> **Merge state.** Everything above except two items is on `develop` (v0.2,
> unpromoted). The **approval-target gate** for native writes (PR #35) and the
> **mounted issue → execution review** (PR #36) are open drafts: until those
> merge, `develop` still lacks the gate and the review is not reachable from the
> product UI. See `doc/v0.2/CURRENT-STATE-20261023.md`.

## Architecture

```
Browser (Next.js app router, React 19)
  │  same-origin fetch, no Clerk token in the browser payload
  ▼
Next route handlers  src/app/api/**
  │  owner-scoped Convex client
  ▼
Convex backend  convex/**
  ├── auth.ts                 owner grant, revision, fail-closed checks
  ├── t3OAuth.ts              PKCE consent, encrypted tokens, tool allowlists
  ├── t3ConnectionsStore.ts   owner-scoped connection inventory
  ├── t3Launch/Send/Interrupt native write actions (operate gate)
  ├── lib/writeTargetPolicy.ts owner-approved write destination (draft PR #35)
  ├── linearOAuth.ts          Linear consent + rotating credentials
  ├── projectMappings.ts      owner-scoped Linear ↔ T3 mappings
  ├── linearIssues.ts         authoritative issue reads
  ├── linearAssociation.ts    thread ↔ issue bindings
  ├── linearSync.ts           bounded, idempotent status sync
  └── verifiedPullRequest.ts  read-only GitHub verification
  │  MCP over Streamable HTTP (bearer token, per-request guards)
  ▼
T3 Code (read tools) and, only for approved destinations, native write tools
```

Two rules shape the backend:

1. **Owner scope is server-side.** Every public function validates the Clerk
   subject against the configured owner grant; the browser never sends an
   identity it could forge.
2. **Reads and writes are separate capabilities.** `t3OAuth.read` exposes six
   read tools through a fixed allowlist. Native writes (`t3_thread_launch`,
   `t3_thread_send`, `t3_thread_interrupt`) require an `operate` grant *and*, once
   PR #35 lands, a deployment-configured approved write target. Unconfigured
   means refused.

`doc/TRD.md` holds the full technical contract. The write-target gate is
documented in `doc/v0.2/native-write-target.md`, which lands with PR #35 — it is
not present on `develop` yet.

## Requirements

- Node.js 20+, pnpm 11
- A Convex deployment (DEV) and a Clerk application
- A T3 Code instance reachable over a trusted HTTPS MCP endpoint
- Optional: a Linear OAuth application, and a read-only GitHub token for PR
  verification

## Local setup

```bash
pnpm install
cp .env.example .env.local     # fill in; never commit it
pnpm dev                       # Next.js on http://localhost:3000
npx convex dev                 # in a second terminal, syncs convex/
```

Environment variables are validated by `convex/lib/envValidation.ts`. Variable
names and purposes are documented in `.env.example`; values are never logged,
returned to the browser, or included in an error message.

## Checks

```bash
pnpm test                      # Convex backend (vitest, edge-runtime)
pnpm run test:frontend         # React unit/SSR (vitest, node)
pnpm run test:frontend:browser # Playwright harnesses (stubbed /api, no live T3)
pnpm run typecheck
pnpm run lint
pnpm run build
```

The browser suite mounts real components against stubbed `/api/*` routes. It
never performs a live T3 write.

## DEV safety and deployment prerequisites

Helm is single-owner and fails closed. Before any DEV acceptance run:

1. **Owner identity** — `HELM_OWNER_SUBJECT`, `CLERK_FRONTEND_API_URL`, and a
   matching Clerk application must be configured; every backend call verifies
   the owner grant server-side.
2. **Linear OAuth** — `LINEAR_CLIENT_ID` (and `LINEAR_CLIENT_SECRET` if the app is
   confidential), `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION=v1`,
   `LINEAR_OAUTH_ENCRYPTION_KEY_V1` (32-byte base64). The redirect URI must be
   exactly `<HELM_APP_URL>/api/linear/callback`.
3. **Approved write target** (lands with PR #35) — `T3_NATIVE_WRITE_ENDPOINT` and
   `T3_NATIVE_WRITE_ENVIRONMENTS`, set to a **disposable** T3 instance and its
   environment id. Until both are set, every native write is refused.
4. **Consents** — one owner sign-in, one T3 operate consent, one Linear consent.
   Consent must be given by the owner in a browser; it cannot be scripted.
5. **Deployment is explicit** — merging a PR does not authorize a DEV or
   Production deployment. Deploy DEV only on owner instruction, verify the
   target deployment identity first, and never point these variables at the real
   relay for disposable testing.

No secret is ever logged, returned to the browser, or included in an error
message. `convex/lib/envValidation.ts` reports presence and shape only.

## Release state

- **v0.1** is on `main`.
- **v0.2** is on `develop` and has not been promoted.
- Open drafts: #35 (write-target gate), #36 (mounted execution review), #37
  (this documentation), #38 (`develop` Next.js 16.4.2 security patch), #39
  (`main` Next.js 16.4.2 security patch).
- `develop` and `main` still pin **Next.js 16.4.0**; #38/#39 are not merged.
- Full DEV acceptance is owner-gated and **pending**.

Current reconciled state: `doc/v0.2/CURRENT-STATE-20261023.md` (lands with #37).
Owner actions: `doc/v0.2/OWNER-ACTIONS.md`.
Release evidence: `doc/v0.2/RELEASE-DOSSIER.html` and
`doc/v0.2/RELEASE-CLOSURE-LEDGER.md`.

## Repository map

```
convex/            Convex schema, functions, policies, tests
src/app/           Next.js routes and the owner dashboard
src/features/      t3, linear, execute feature modules
tests/frontend/    Playwright harnesses (stub /api, real components)
doc/               requirements, design, verification, v0.2 evidence
e2e/               owner-auth end-to-end spec
```
