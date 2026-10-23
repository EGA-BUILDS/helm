# Next.js security patch — 16.4.0 → 16.4.2 (`main`, v0.1)

Date: 2026-10-23
Branch: `security/next-16.4.2-main` → `main`
Scope: dependency patch only (`next`, `eslint-config-next`). No other package
versions were changed.

## Advisories affecting `next@16.4.0`

| GHSA | Severity | Package | Vulnerable | Patched | Summary |
|---|---|---|---|---|---|
| [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in the Image Optimization API when SVG files are used |
| [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in `use cache` functions returning typed arrays |
| [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) | high | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Denial of service in the App Router using Server Actions |

`main` is the Production branch and pins the affected versions, so it is
affected by all three.

## Change

```diff
-    "next": "16.4.0",
+    "next": "16.4.2",
...
-    "eslint-config-next": "16.4.0",
+    "eslint-config-next": "16.4.2",
```

Lockfile refreshed with the pinned `pnpm@11.15.0`.

## Verification

- installed `next` / `eslint-config-next`: `16.4.2` / `16.4.2`
- `pnpm why next@16.4.0`: no match
- lockfile diff: only the two packages' snapshot keys and peer suffixes
- `pnpm audit` after patch: **zero** `next` advisories
- `pnpm run build`: passed on the **first** attempt (no advisory-gate retry)

Gates on this branch:

- `pnpm test` — 191 passed / 14 files
- `pnpm run test:frontend` — 186 passed / 5 files
- `pnpm run test:frontend:browser` — 40 passed
- `pnpm run typecheck` — passed
- `pnpm run lint` — 0 errors, 1 pre-existing warning (`postcss.config.mjs`)
- `pnpm run build` — passed, no retry

## Residual advisories (not changed here)

Same two pre-existing findings as on `develop`, deliberately out of scope for a
security-only Next.js bump:

| GHSA | Severity | Package | Path | Note |
|---|---|---|---|---|
| GHSA-vfj7-8cjw-p6xm | high | `braces@3.0.3` | `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces` | dev-only lint tooling, not in the production bundle; minimal follow-up is a `pnpm.overrides` bump to `^3.0.4` |
| GHSA-rxp7-6hxx-x8q5 | moderate | `ip-address@10.7.3` | `@modelcontextprotocol/sdk → express-rate-limit → ip-address` | runtime transitive; needs its own SDK/override change |

## Deployment boundary

Preparing this branch does **not** authorize a Production deployment. Merging to
`main` and any Vercel Production release both require explicit owner approval.
