# Verification

How to confirm the Helm foundation (EGA-676) locally and how each check is wired.

## Local verification commands

Run from the repository root with Node 24 and the pinned pnpm
(`packageManager` in `package.json`).

```bash
pnpm install --frozen-lockfile

# Lint authored source (Convex generated output is ignored — see below)
pnpm lint

# TypeScript, no emit
pnpm typecheck

# Production build. Cache Components + Partial Prefetching are ON, so this
# command is the real prerender gate.
pnpm build
```

`pnpm typecheck` runs `next typegen` before `tsc --noEmit` because `LayoutProps`
and `PageProps` are generated into the gitignored `.next/types/`, so `tsc` alone
fails on a clean checkout with `Cannot find name 'LayoutProps'`. `next build`
also runs its own TypeScript pass, so `typecheck` is a fast gate, not the only
type-safety net.

Expected results:

- `pnpm lint` — exits 0, no output.
- `pnpm typecheck` — runs `next typegen`, then `tsc --noEmit` exits 0.
- `pnpm build` — reports `Cache Components enabled`, `Partial Prefetching
  enabled`, `✓ Compiled successfully`, then a route table such as:

  ```text
  Route (app)
  ┌ ○ /
  └ ○ /_not-found

  ○  (Static)  prerendered as static content
  ```

## Hosted backend proof

```bash
# Pushes convex/ to the configured dev deployment and typechecks the functions
npx convex dev --once

# Runs the public no-data health query against that deployment
npx convex run health:check '{}'
```

Expected:

```json
{ "status": "ok" }
```

## Production render proof

```bash
pnpm build
pnpm start -p 3123 &
sleep 3
curl -s http://localhost:3123/
kill %1
```

The served HTML contains the Helm title and the prerendered static shell
(`<h1>Helm</h1>`, `Your software execution hub.`).

### Why the SSR shell shows "Connecting to Convex…"

`health.check` is read by `useQuery` in a Client Component
(`src/app/ConvexHealthStatus.tsx`), which is the documented way to read a
Convex query from a Cache Components route. The Convex client connects to the
hosted deployment over a WebSocket in the browser, so the server can only
prerender a fallback into the static shell. That is why the `<Suspense>`
fallback (`role="status"` → `Connecting to Convex…`) is what appears in
`curl` output, and why `Convex connected` appears after the browser hydrates
and the hosted query resolves. The hosted query itself is proven separately by
`npx convex run health:check '{}'` above.

## Why the provider sits behind `<Suspense>`

`next.config.ts` sets `cacheComponents: true`. `new ConvexReactClient(url)`
calls `Math.random()` to mint its session id, and Cache Components refuses to
evaluate non-deterministic values while prerendering:

```text
Error: Route "/": Next.js encountered the unstable value `Math.random()` in a
Client Component.
```

Next.js's own fix list for that error is `[stream]` wrap the Client Component in
`<Suspense>`, and that is what `ConvexClientProvider` does: the boundary sits
above the component that constructs `ConvexReactClient`, so it surrounds
provider initialization itself rather than only the page below it. A
`Math.random()` shim is not used, Cache Components is not disabled, and the
client is still created exactly once per provider instance via `useState`.

Keeping the shell is also why the provider wraps only the Convex-using subtree
in `src/app/page.tsx` instead of the whole root layout: everything inside that
boundary is replaced by the fallback in the prerendered shell, so the Helm
heading and tagline stay outside it and remain visible immediately.

**Constraint for EGA-678 (owner login / auth):** because the boundary lives in
`src/app/page.tsx`, the authenticated provider (`ConvexProviderWithAuth` from
`convex/react`) must be added inside or above this provider within the page — a
`useQuery` placed above any provider fails `next build` at prerender
(`Could not find Convex client!`), so a forgotten provider is a build failure,
not a silent runtime fallback. Do not naively wrap `ConvexProviderWithAuth`
around the whole root layout: that would re-introduce a whole-page prerender
boundary and drop the Helm heading from the static shell. Restructure the
layout/page deliberately if the app-wide provider is preferred, and confirm `/`
stays `○ (Static)`.

## Configuration handling

`ConvexClientProvider` branches on `NEXT_PUBLIC_CONVEX_URL` only:

- Set — the configured subtree renders inside `ConvexProvider`, so every
  `useQuery` call has a provider above it.
- Unset — `ConvexSetupRequired` renders instead, with no Convex hooks at all,
  so nothing is called outside a provider and the page does not crash.

No deployment URL is hardcoded in source. `.env.local` holds the dev deployment
URL and is gitignored.

## Generated-file lint handling

`eslint.config.mjs` ignores `convex/_generated/**`. Convex rewrites those files
on every push and ships directive comments that surface lint warnings in
authored-source reports; they cannot be fixed in this repo, so they are
excluded from lint and `convex/_generated/**` is never edited by hand:

```js
// Generated Convex output (convex/_generated/**). Convex rewrites these files
// on every push, so their lint warnings cannot be fixed in this repo and
// they must not fail authored-source lint runs.
"convex/_generated/**",
```

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests. For each
of Node 24 and Node 22 it does `pnpm install --frozen-lockfile`, then `pnpm
lint`, `pnpm typecheck`, `pnpm build`. It passes no secrets and touches no
hosted backend: CI never calls T3 and never deploys Convex functions.

## Known limits

- `Convex connected` is only observable after browser hydration; it is not in
  the prerendered HTML (see above).
- `ConvexHealthStatus` shows `Connecting to Convex…` whenever the query returns
  `undefined`, which covers both loading and a well-formed-but-dead backend
  (e.g. a deleted dev deployment). A distinct, actionable "unreachable" state
  with `last-known-health` separation is an EGA-679 (F2 connection checks)
  concern and is intentionally deferred from this foundation.
- `npx convex dev --once` needs a working `~/.convex` login and the precompiled
  local backend binary. On a host whose glibc is older than the binary needs,
  the local-backend step fails, but the push/typecheck of `convex/` does not
  depend on it.
