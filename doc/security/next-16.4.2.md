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

`pnpm audit` on the unpatched lockfile reported 2 critical + 1 high for `next`.
`next@16.4.2` is the selected stable patch: above every patched floor
(`16.4.1`) and the latest confirmed stable release at the time of writing.

## Applicability in Helm — what is and is not proven

**An affected version range identifies exposure in principle; it does not by
itself prove a runtime exploit path.** Checked against this repository:

| Advisory | Helm usage at the time of the patch | Evidence |
|---|---|---|
| GHSA-2464 image optimizer SVG RCE | The advisory documents **`sharp >= 0.35.5` as the workaround**. The lockfile already resolves **`sharp@0.35.5`** (Next's optional image-optimization dependency), so that condition is met. The framework-level fix still applies. | `pnpm-lock.yaml`: `sharp@0.35.5`; `next.config.ts` sets no custom image loader |
| GHSA-673q `use cache` typed-array RCE | The repository contains **no `"use cache"` directive**. `cacheComponents: true` is enabled, but without a `use cache` function the described sink is not present. | `grep -rn '"use cache"' src convex` → no matches |
| GHSA-p3m5 Server Actions DoS | The advisory **excludes applications without Server Actions**, and the repository contains **no `"use server"` directive** or server-action module. | `grep -rn '"use server"' src convex` → no matches |

None of these observations is presented as proof that the app was exploitable.
They are the reason the patch is described as **defense in depth**, not as an
incident response: the framework fix is available, cheap, and removes the
question entirely. The patch does not depend on proving exploitability.

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
keys and their peer suffixes; `sharp` stays at `0.35.5`.

## Verification

Common to both branches:

- installed `next` / `eslint-config-next`: `16.4.2` / `16.4.2`
- `pnpm why next@16.4.0`: no match
- lockfile `next@16.4.x` entries: only `next@16.4.2`
- `@clerk/nextjs` peer-resolves against the single `next@16.4.2` (no second copy)
- `sharp` remains `0.35.5`
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

## Residual advisories (not changed here, deliberately)

Outside the authorized scope (a Next.js security bump, not a broad dependency
upgrade). Recorded so they are not mistaken for patched.

| GHSA | Severity | Package | Path | Why not fixed here |
|---|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | high | `braces@3.0.3` | `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces` | **dev-only** lint tooling; not in the production server bundle. Minimal follow-up: `pnpm.overrides` bump to `braces@^3.0.4` as its own change. |
| [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | moderate | `ip-address@10.7.3` | `@modelcontextprotocol/sdk → express-rate-limit → ip-address` | runtime transitive; a 10.x bump of an MCP SDK transitive is not a Next.js patch. Follow-up: upgrade to `>=10.7.4` via the SDK or an override, with its own tests. |

Both pre-date this change; the patch neither introduces nor worsens them.

## Deployment boundary

- **#38 (`develop`)**: merging the patch does not deploy DEV or Production.
- **#39 (`main`)**: this is the security-only Production change. Its merge is
  the owner's authorization for the resulting automatic Vercel Production
  deployment. It does **not** promote v0.2; `main` carries v0.1 apart from this
  dependency patch.
