# Helm v0.2 — EGA-770 hosted DEV preparation

Documentation + validation only. No resource, deployment, OAuth client or
credential was provisioned by this issue. No live DEV verification was performed
and none is claimed.

## 1. Derived environment variables (from code)

Enumerated by grepping `process.env` across `src/` and `convex/` (excluding
tests and generated files). Names only — never values.

| Variable | Side | Required? | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | Next / Vercel | Required | Browser subscribes to this Convex deployment. Public by design. |
| `HELM_APP_URL` | Both (Next + Convex) | Required | Next: origin check for mutating routes + post-callback redirect. Convex: OAuth `redirect_uri` for T3 and Linear. Must agree. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Next / Vercel | Required | Clerk browser provider + sign-in UI. |
| `CLERK_SECRET_KEY` | Next / Vercel (Clerk SDK) | Required (SDK-managed) | Server-side Clerk session verification. Not directly read by app code; consumed by the Clerk SDK. |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Next / Vercel | Optional | Convex dashboard link, diagnostics only. Not currently read by app code. |
| `NEXT_PUBLIC_HELM_T3_FIXTURES` | Next / Vercel | Optional | Enables fixture data in the T3 workspace (development only). |
| `CLERK_FRONTEND_API_URL` | Convex | Required | Clerk JWT issuer for `convex/auth.config.ts`. |
| `HELM_OWNER_SUBJECT` | Convex | Required | Single immutable owner identity enforced server-side. |
| `T3_OAUTH_ENCRYPTION_KEY_VERSION` | Convex | Optional (default `v1`) | Active T3 key version selector. |
| `T3_OAUTH_ENCRYPTION_KEY_V1` | Convex | Required (for active version) | 32-byte AES key, base64, for sealing T3 OAuth tokens. |
| `T3_OAUTH_ENCRYPTION_KEY` | Convex | Optional (legacy v1 fallback) | Legacy T3 key; remove after migration. |
| `LINEAR_CLIENT_ID` | Convex | Required | Linear OAuth public client id. Fails closed when absent. |
| `LINEAR_CLIENT_SECRET` | Convex | Optional | Only if the Linear app is confidential. |
| `LINEAR_OAUTH_ENCRYPTION_KEY_VERSION` | Convex | Optional (default `v1`) | Active Linear key version selector. |
| `LINEAR_OAUTH_ENCRYPTION_KEY_V1` | Convex | Required (for active version) | 32-byte AES key, base64, for sealing Linear tokens. |
| `LINEAR_OAUTH_ENCRYPTION_KEY` | Convex | Optional (legacy v1 fallback) | Legacy Linear key; remove after migration. |
| `T3_MCP_URL` | Convex | Required (discovery) | PRIVILEGED discovery-only T3 MCP endpoint. Never used for dispatch, never a fallback. |
| `T3_MCP_TOKEN` | Convex | Required (discovery) | Bearer credential for privileged T3 MCP discovery reads. |
| `T3_MCP_URL_ISOLATED` | Convex | Required (dispatch) | ISOLATED T3 MCP endpoint dispatch may launch on. |
| `T3_MCP_TOKEN_ISOLATED` | Convex | Required (dispatch) | Bearer credential for the isolated T3 instance. |
| `T3_PROJECT_ID_ISOLATED` | Convex | Required (dispatch) | Trusted isolated T3 project binding. |
| `LINEAR_API_KEY` | Convex | Required | Server-side Linear GraphQL reads (read scope). |
| `LINEAR_PROJECT_ID` | Convex | Required | Target Linear project. |

Platform-provided (not app configuration): `NODE_ENV`, `CONVEX_SITE_URL`,
`CONVEX_CLOUD_URL` (Convex runtime). `CONVEX_DEPLOYMENT` is local-CLI only.

Not read by current code (do not validate): `HELM_REPOSITORY`,
`HELM_BASE_REF` — named in earlier owner notes but no code path reads them.

## 2. DEV targets — known vs unknown vs owner-supplied

| Target | Status | Notes |
|---|---|---|
| Vercel DEV origin | **Unknown / unverified** | Previews are per-branch; no canonical DEV origin is recorded. Owner must pick one and set `HELM_APP_URL` everywhere. |
| Convex DEV deployment | **Known** | `hardy-warthog-60.eu-west-1`. |
| Clerk Development instance + owner identity | **Configured on Convex DEV, grant missing** | `CLERK_FRONTEND_API_URL` and `HELM_OWNER_SUBJECT` are set on DEV Convex. Vercel-side keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) are owner-supplied. **No `ownerGrants` row exists yet** — owner must sign in once and run `grantOwner`. Whether the DEV Clerk instance is distinct from Production's is **unverified**; owner must confirm. |
| Linear OAuth client + encryption key | **Owner-supplied (missing)** | `LINEAR_CLIENT_ID`, (optional) `LINEAR_CLIENT_SECRET`, `LINEAR_OAUTH_ENCRYPTION_KEY_V1` are NOT set on DEV Convex. Create the Linear OAuth app with redirect URI `<HELM_APP_URL>/api/linear/callback`. |
| T3 MCP endpoint + native server version | **Partially known** | `T3_MCP_URL`, `T3_MCP_TOKEN`, `T3_MCP_URL_ISOLATED`, `T3_MCP_TOKEN_ISOLATED`, `T3_PROJECT_ID_ISOLATED` are set on DEV Convex (presence only). Hosted reachability from Convex Cloud and the native server version are **unverified** (historical probe showed unreachable). Owner must confirm the HTTPS exposure path and record the version. |
| Separate DEV operate consent | **Missing / owner-supplied** | No `t3Connections` row exists on DEV. EGA-758 disposable write probe requires an explicit owner GO, including whether an `orchestration:operate` grant may be requested. |
| Environment scope per variable | **Documented** | See table in §1 (`Side` column): `next` = Vercel/Next, `convex` = Convex deployment, `both` = must agree in both runtimes. |

## 3. Configuration validator

Location: `convex/lib/envValidation.ts` (with `convex/lib/envValidation.test.ts`).

Why there: every existing pure validation helper in this repo lives under
`convex/lib/` (`dispatchConfig.ts`, `dispatchConfigValidation.ts`,
`t3EndpointPolicy.ts`, `linearHelpers.ts`) and is consumed by Convex code and
tests in the edge runtime. Placing the validator there matches that convention,
lets it reuse `isValidIsolatedEndpoint` from `dispatchConfigValidation.ts`
instead of duplicating the URL policy, and keeps a single source of truth rather
than a second competing env layer.

API:
- `validateEnv(env = process.env)` → `{ ok, issues, errors }`. Never throws; never
  returns a value. This is the only exported entry point.
- Wired into `reportIntegrationSetup` (`convex/integration/setup.ts`) as the
  `environment` section, so an owner runs it via
  `npx convex run internal.integration.setup.reportIntegrationSetup`.

Each missing or malformed variable produces one distinct, actionable message
naming the variable and the fix. Secret values are never logged or returned —
only variable names and problem descriptions.

What it catches:
- Missing required variables (next + convex + both sides).
- Malformed URLs (`NEXT_PUBLIC_CONVEX_URL`, `HELM_APP_URL`,
  `CLERK_FRONTEND_API_URL`, `T3_MCP_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`).
- `HELM_APP_URL` must be https without embedded userinfo.
- Invalid isolated endpoint (reuses shared policy).
- Missing/invalid 32-byte base64 encryption keys for both T3 and Linear,
  including active-version resolution and the v1 legacy fallback.
- Bad version selectors, bad Clerk subject, placeholder values treated as
  missing, optional-variable shape errors.

## 4. DEV separation runbook

Confirm the DEV environment is genuinely separate from Production:

1. **Distinct origin**: Vercel DEV deployment's `HELM_APP_URL` differs from
   Production's canonical origin (`https://helm-lyart.vercel.app`). Verify in the
   Vercel project environment for the DEV/preview scope.
2. **Distinct Convex deployment**: `CONVEX_DEPLOYMENT` / `NEXT_PUBLIC_CONVEX_URL`
   point at `hardy-warthog-60.eu-west-1`, not the Production deployment. Check
   presence only: `npx convex env list | cut -d= -f1` on the DEV deployment.
3. **Distinct Clerk instance**: `CLERK_FRONTEND_API_URL` issuer host and
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` belong to the Clerk Development instance,
   not Production. Owner attests instance separation.
4. **Distinct OAuth consent**: Linear client redirect URI is
   `<DEV HELM_APP_URL>/api/linear/callback`; T3 isolated endpoint/token/project
   are DEV-specific. No Production token is reused.
5. **No Production credential present**: owner attests that no Production
   `T3_MCP_TOKEN`, `LINEAR_API_KEY`, Clerk secret or encryption key was copied
   into DEV. (Values are never compared or printed.)
6. Run the env validator against the DEV environment and confirm `ok: true`,
   and run `reportIntegrationSetup` to confirm no `missing`/`placeholder` checks.

## 5. Exit criteria for EGA-685 (acceptance stays PENDING until met)

Owner must supply and do all of the following before real R01–R12 acceptance
can run. **Without these, acceptance stays PENDING and no criterion is claimed
as passed.**

- [ ] Stable Vercel DEV origin chosen; `HELM_APP_URL` set in Vercel (DEV scope)
      and in Convex DEV.
- [ ] Vercel DEV scope has `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
      `CLERK_SECRET_KEY` for the Clerk Development instance.
- [ ] Confirmed the Clerk Development instance is distinct from Production's.
- [ ] First owner sign-in on the DEV origin completed; `grantOwner` run so an
      `ownerGrants` row exists.
- [ ] Linear OAuth application created (redirect URI `<HELM_APP_URL>/api/linear/callback`);
      `LINEAR_CLIENT_ID`, (optional) `LINEAR_CLIENT_SECRET`,
      `LINEAR_OAUTH_ENCRYPTION_KEY_V1` set on DEV Convex.
- [ ] One Linear consent completed on DEV (creates `linearConnections` row).
- [ ] T3 HTTPS exposure path from Convex Cloud confirmed; native server version
      recorded; reachability re-probed successfully.
- [ ] One native T3 consent completed on DEV (creates `t3Connections` row).
- [ ] Explicit owner GO for the EGA-758 disposable DEV write probe, including
      whether an `orchestration:operate` grant may be requested.
- [ ] Env validator (`convex/lib/envValidation.ts`) returns `ok: true` for DEV.
- [ ] `reportIntegrationSetup` shows no `missing`/`placeholder`/`invalid` for
      the required checks.

No live DEV verification was performed by this issue and none is claimed.