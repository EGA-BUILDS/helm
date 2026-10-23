# Next.js security patch — 16.4.0 → 16.4.2

Date: 2026-10-23
Scope: dependency patch only (`next`, `eslint-config-next`). No other package
versions were changed.

## Advisories affecting `next@16.4.0`

Source: `pnpm audit` against the repository's lockfile, and the GitHub Advisory
Database entries below.

| GHSA | Severity | Package | Vulnerable | Patched | Summary |
|---|---|---|---|---|---|
| [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in the Image Optimization API when SVG files are used |
| [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) | **critical** | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Unauthenticated remote code execution in `use cache` functions returning typed arrays |
| [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) | high | `next` | `>=16.0.0 <=16.4.0` | `>=16.4.1` | Denial of service in the App Router using Server Actions |

`next@16.4.2` is the selected stable patch. It is above every patched floor
(`16.4.1`) and is the latest confirmed stable release at the time of writing.

Helm is affected in principle regardless of whether a given feature is used: the
vulnerable code ships in the framework, and the Image Optimization endpoint is
part of the default Next.js runtime. Patching is the correct response; feature
non-use is not a mitigation.

## Change

```diff
-    "next": "16.4.0",
+    "next": "16.4.2",
...
-    "eslint-config-next": "16.4.0",
+    "eslint-config-next": "16.4.2",
```

Lockfile updated with the repository's pinned package manager (`pnpm@11.15.0`).

## Verification

| Check | Result |
|---|---|
| `node_modules/next/package.json` | `16.4.2` |
| `node_modules/eslint-config-next/package.json` | `16.4.2` |
| `pnpm list next eslint-config-next --depth 0` | both `16.4.2`, 2 packages |
| `pnpm why next@16.4.0` | no match |
| Lockfile `next@16.4.x` entries | only `next@16.4.2` |
| `@clerk/nextjs` resolution | peer-resolved against `next@16.4.2` (no second Next copy) |
| Lockfile diff | only the `next` / `eslint-config-next` snapshot keys and their peer suffixes |
| `pnpm audit` after patch | `next` advisories: **0** (was 2 critical + 1 high) |
| `pnpm run build` | passed on the **first** attempt; the pre-patch security-advisory stop did not recur |

Gates on the patched tree:

- `pnpm test` — 725 passed / 42 files
- `pnpm run test:frontend` — 403 passed / 27 files
- `pnpm run test:frontend:browser` — 83 passed
- `pnpm run typecheck` — passed
- `pnpm run lint` — 0 errors, 1 pre-existing warning (`postcss.config.mjs`)
- `pnpm run build` — passed, no retry needed

The "successful retry" caveat from the previous pass no longer applies: this
build succeeded once, and the advisory gate that forced the earlier retry is
gone because the installed Next version is no longer vulnerable.

## Residual advisories (not changed here, deliberately)

These are **outside** the authorized patch scope (a Next.js security bump, not a
broad dependency upgrade). They are recorded so they are not mistaken for patched.

| GHSA | Severity | Package | Path | Why not fixed here |
|---|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | high | `braces@3.0.3` | `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces` | **dev-only** lint tooling; not present in the production server bundle. A `pnpm.overrides` bump to `braces@^3.0.4` is the minimal follow-up and should be its own change. |
| [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | moderate | `ip-address@10.7.3` | `@modelcontextprotocol/sdk → express-rate-limit → ip-address` | runtime transitive, but a 10.x bump of an MCP SDK transitive is not a Next.js patch. Follow-up: upgrade `ip-address` to `>=10.7.4` via the SDK or an override, with its own tests. |

Both were already present before this change; the patch neither introduces nor
worsens them.

## `main` (v0.1)

`main` pins the same `next@16.4.0` / `eslint-config-next@16.4.0` pair and is
therefore affected by the same three advisories. A separate security-only PR
targets `main` with the identical two-line change. It must not be merged or
deployed to Production without explicit owner approval.
