# Hosted DEV acceptance path for PR #33 (EGA-769)

**Status: the path is established; executing it is owner-gated.** Nothing in this
document was performed on the owner's behalf: no merge, no Vercel environment or
domain change, no Convex DEV environment change, no real Operate consent, no
Production deployment, and no attempt to get past Vercel's deployment
protection.

This is the "add another access level" flow: a second, separate T3 consent that
grants `orchestration:operate` without touching the existing read-only
connection.

## 1. What the code requires of the deployment

The hosted round trip is only coherent when one origin is authoritative for the
whole flow. Three pieces of code decide that origin, and they must agree:

| Piece | Code | Value it uses |
|---|---|---|
| OAuth redirect URI sent to T3 | `convex/t3OAuth.ts` → `callbackUri()` | the **Convex** deployment's `HELM_APP_URL` → `<origin>/api/t3/callback` |
| Same-origin check before a consent starts | `src/app/api/t3/oauth/start/route.ts` → `requireSameOrigin()` | the **Vercel** deployment's `HELM_APP_URL` (must equal the browser's `Origin`) |
| Redirect back to the dashboard after the callback | `src/app/api/t3/callback/route.ts` → `helmHomeUrl()` | the **Vercel** deployment's `HELM_APP_URL` |

Consequences that decide the path:

* A client-supplied redirect URI cannot move the flow elsewhere: the backend
  accepts it only when it equals the one it derived, otherwise it fails with
  `OAuth callback URI mismatch` (`convex/t3OAuth.ts`, `start`).
* The T3 OAuth client is registered dynamically (RFC 7591) with that redirect
  URI, so the provider is not the constraint — **the origin is**.
* Therefore the frontend that runs the round trip must be served from the
  origin the Convex deployment names. A preview on any other origin can be the
  browser, but it cannot be the actor: either `requireSameOrigin` refuses the
  start request (`cross_origin_request`), or the provider sends the browser to
  the Convex-configured origin, where a *different* build answers.

## 2. Verified deployment facts

| Fact | Value | How it was verified |
|---|---|---|
| Convex DEV deployment | `dev:hardy-warthog-60` (team `helm`, project `helm`), `https://hardy-warthog-60.eu-west-1.convex.cloud` | `npx convex dev --once` target; `CONVEX_DEPLOYMENT` in `.env.local` |
| Convex DEV `HELM_APP_URL` | `https://dev-helm.egawilldoit.online` | `npx convex env get HELM_APP_URL` (a public URL; no secret was read or printed) |
| OAuth redirect URI in force | `https://dev-helm.egawilldoit.online/api/t3/callback` | derived by `callbackUri()` from the value above |
| Vercel project | `helm` in the `ega-builds` team (`prj_wTyBORs1Qvd03vTXo3P3CICkI3zB`) | Vercel's own comment on PR #33 |
| PR branch alias | `https://helm-git-fix-t3-oauth-operate-diagnostics-ega-builds.vercel.app` | Vercel's own comment on PR #33; the host answers |
| `develop` branch alias | `https://helm-git-develop-ega-builds.vercel.app` | the host answers; a control alias (`helm-git-nonexistent-branch-…`) answers `404`, so the two real aliases exist |
| Deployment protection | all three origins answer `302 → https://vercel.com/sso-api/…` | `curl -I` on each host |
| Vercel scope access from this environment | **none** — the CLI is authenticated to `trackgym101-1390` / team `gym-track3`; `--scope ega-builds` is rejected with `The specified scope does not exist` | `vercel whoami`, `vercel teams ls`, `vercel ls --scope ega-builds` |
| Convex DEV live connections | none (`listConnections` → `[]`) | read-only `npx convex run internal.t3ConnectionsStore.listConnections` on DEV |
| Production | untouched — `origin/main` is still `0e863c4`; no `npx convex deploy` was run | `git rev-parse origin/main`; only `npx convex dev --once` was used |

## 3. The gap, and why it cannot be closed from this environment

The Convex DEV deployment names `https://dev-helm.egawilldoit.online`, and
that origin serves the **`develop`** build. PR #33's frontend exists only on
the PR branch alias. Those are different origins, so:

* with the PR Preview as the browser, `requireSameOrigin` refuses the consent
  start, because the Vercel `HELM_APP_URL` of that preview is not the
  Convex-configured origin; and
* even if that check were satisfied, the provider would send the browser to
  the Convex-configured origin, where the develop build — not PR #33 — answers
  the callback and renders the dashboard.

So the PR's new frontend cannot be the actor in a real hosted OAuth round trip
until it is served from the Convex-configured origin.

Closing the gap needs an owner decision, not a code change. Two candidate paths:

**A — merge PR #33 into `develop` (recommended).** The DEV origin then serves
the PR's build, the existing `HELM_APP_URL` configuration stays correct on
both sides, the Convex DEV backend already carries this branch's code, and
Production is untouched. This is the dependency the review asked to be
documented rather than bypassed. It requires owner approval, and it is the
same merge EGA-685 needs for its real-browser DEV evidence.

**B — re-point the DEV identity to the PR branch alias.** Set the Vercel
project's `HELM_APP_URL` to the PR branch alias *and* change the Convex DEV
deployment's `HELM_APP_URL` to the same value, so the redirect URI follows.
This is a Vercel-project operation in a scope this environment cannot reach
(`ega-builds`), and it changes a shared DEV deployment's configuration and the
owner's shared DEV origin. It is reversible, but it must be owner-operated, and
it is not a change an agent should make silently.

Path A is the smaller, safer change and is the one recommended here.

## 4. What the acceptance itself will need

Once path A is approved and the DEV origin serves the PR build, the real
Operate acceptance additionally requires:

1. **A Vercel account session.** Every DEV origin is behind deployment
   protection; the acceptance must run in a browser signed in to Vercel, then
   signed in to the Clerk DEV instance as the owner.
2. **A live read-only connection on DEV.** DEV currently has none
   (`listConnections` → `[]`), and the previous row was `disconnected`. The
   flow under test starts from an existing read-only connection, so a
   read-only consent has to be re-established first.
3. **An Operate grant that is not a production escalation.** The T3 relay the
   owner uses points at the real environment
   (`https://prod-e0eb33007bdbf8c3.t3coderelay.com/mcp`). `orchestration:operate`
   there is an environment-wide permission escalation and needs explicit,
   informed owner approval; per the product intent, the first write acceptance
   must target a disposable project on an isolated endpoint.
4. **Production and the real T3 server left unchanged**, and the live T3 data
   left untouched.

## 5. What is already proven without the hosted round trip

The frontend behaviour of this PR is covered by automated tests that stub the
network — they prove the *request shape and refusal logic*, not a live
consent:

* `src/features/t3/dashboard.test.tsx` — the read-only connection stays
  available, "Add another access level" is offered, the prefilled form
  targets the other tier, and the existing-connection message is shown.
* `tests/frontend/live-dashboard.spec.ts` — the browser test asserts that
  choosing Operate starts a **new** consent with `access: "operate"` and **no**
  `connectionId`, that a duplicate grant for an existing tier is prevented,
  that Cancel issues no authorization request, and that the correct connection
  appears after a successful authorization.

Those are mocked browser tests. They are **not** hosted-authentication
evidence. The hosted acceptance stays PENDING until the owner approves path A
(or operates path B) and the prerequisites in §4 are met.
