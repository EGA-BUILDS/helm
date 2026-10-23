# Next.js security patch — 16.4.0 → 16.4.2

Date: 2026-10-23
Scope: dependency patch only (`next`, `eslint-config-next`). No other package
versions were changed.

This document is intentionally identical on `develop` (PR #38) and `main`
(PR #39), so the next `develop → main` merge has no add/add conflict.

## Advisories affecting `next@16.4.0`

| GHSA | Severity | Package | Vulnerable | Patched | Summary |
|---|---|---|---|---|---|
| [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in the Image Optimization API when SVG files are used |
| [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in `use cache` functions returning typed arrays |
| [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) | high | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Denial of service in the App Router using Server Actions |

`pnpm audit` on the unpatched lockfile reported **2 critical + 1 high** for
`next`. `next@16.4.2` is the selected stable patch: above every patched floor
(`16.4.1`) and the latest confirmed stable release at the time of writing.

Feature non-use is not a mitigation. The vulnerable code ships in the
framework, and the Image Optimization endpoint is part of the default Next.js
runtime.

## Change

```diff
-    "next": "16.4.0",
+    "next": "16.4.2",
...
-    "eslint-config-next": "16.4.0",
+    "eslint-config-next": "16.4.2",
```

Lockfile refreshed with the repository's pinned package manager
(`pnpm@11.15.0`). The lockfile diff is limited to these two packages' snapshot
keys and their peer suffixes.

## Verification

Common to both branches:

- installed `next` / `eslint-config-next`: `16.4.2` / `16.4.2`
- `pnpm why next@16.4.0`: no match
- lockfile `next@16.4.x` entries: only `next@16.4.2`
- `@clerk/nextjs` peer-resolves against the single `next@16.4.2` (no second copy)
- `pnpm audit` after patch: **zero** `next` advisories
- `pnpm run build`: passed on the **first** attempt; the pre-patch
  security-advisory stop did not recur

Branch gates:

| Gate | `develop` (PR #38) | `main` (PR #39) |
|---|---|---|
| `pnpm test` | 725 passed / 42 files | 191 passed / 14 files |
| `pnpm run test:frontend` | 403 passed / 27 files | 186 passed / 5 files |
| `pnpm run test:frontend:browser` | 83 passed | 40 passed |
| `pnpm run typecheck` | passed | passed |
| `pnpm run lint` | 0 errors, 1 pre-existing warning | 0 errors, 1 pre-existing warning |
| `pnpm run build` | passed, no retry | passed, no retry |

The "successful retry" caveat from earlier runs no longer applies: the patched
tree builds once, and the advisory gate that forced the retry is gone because
the installed Next version is no longer vulnerable.

## Residual advisories (not changed here, deliberately)

Outside the authorized scope (a Next.js security bump, not a broad dependency
upgrade). Recorded so they are not mistaken for patched.

| GHSA | Severity | Package | Path | Why not fixed here |
|---|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | high | `braces@3.0.3` | `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces` | **dev-only** lint tooling; not in the production server bundle. Minimal follow-up: `pnpm.overrides` bump to `braces@^3.0.4` as its own change. |
| [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | moderate | `ip-address@10.7.3` | `@modelcontextprotocol/sdk → express-rate-limit → ip-address` | runtime transitive; a 10.x bump of an MCP SDK transitive is not a Next.js patch. Follow-up: upgrade to `>=10.7.4` via the SDK or an override, with its own tests. |

Both pre-date this change; the patch neither introduces nor worsens them.

## Deployment boundary

Preparing these branches does **not** authorize a Production deployment.
Merging to `main` and any Vercel Production release require explicit owner
approval. The `develop` patch (#38) must land before #35–#37 are synchronized,
because they were authored against `develop@b85a8e3`.
