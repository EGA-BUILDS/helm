# Native T3 write target — the fail-closed gate

Status: implemented on `develop` candidate (PR A of the v0.2 completion plan).
Date: 2026-10-23.
Scope: `convex/t3Launch.ts`, `convex/t3Send.ts`, `convex/t3Interrupt.ts`,
`convex/lib/writeTargetPolicy.ts`, `convex/lib/envValidation.ts`.

## The problem this closes

Every native T3 write (launch, follow-up send, interrupt) resolves the saved
`operate` OAuth grant and sends the tool call to **that grant's endpoint**:

```ts
operateToolCall(secret.endpoint, token, secret.access, "t3_thread_launch", …)
```

Before this change the only destination facts were:

| Fact | Where it is enforced |
|---|---|
| endpoint is HTTPS on a trusted `*.t3coderelay.com` host | `t3OAuth.validateUrl` / `safeFetch` on every request |
| the grant is `access: "operate"` and `status: "connected"` | `lib/operateGate` + `operateToolCall` |
| the mapping's `t3EnvironmentId` equals the grant's environment | `t3Launch.launch` (step 3) |
| the mapping's T3 project exists in that environment | `projectMappings.save` (`project` read) |
| the token is bound to owner + endpoint (AAD) | `decryptStoredToken` |

None of that answers **"is this destination one the owner approved for
writes?"** A correctly-scoped operate grant pointed at the real relay and one
pointed at a disposable instance are indistinguishable. `T3_MCP_URL_ISOLATED`
does not help: it is read only by `convex/dispatch.ts`, the older bearer-token
dispatch path, not by the OAuth write actions.

## The gate

Two Convex environment variables declare the approved destination:

```text
T3_NATIVE_WRITE_ENDPOINT      exact MCP endpoint approved for native writes
T3_NATIVE_WRITE_ENVIRONMENTS  comma-separated T3 environment ids approved for writes
```

`convex/lib/writeTargetPolicy.ts` is pure and is called by all three write
actions **before any network call**, including before the Linear issue read and
the live catalogue read in `t3Launch.launch`.

Refusal table (all fail closed; none echoes the configured value):

| Condition | Refusal |
|---|---|
| `T3_NATIVE_WRITE_ENDPOINT` absent/blank | `endpoint_not_configured` |
| `T3_NATIVE_WRITE_ENVIRONMENTS` absent or whitespace-only | `environments_not_configured` |
| endpoint not an absolute HTTPS URL, has userinfo/query/fragment/whitespace | `endpoint_malformed` |
| any environment entry empty-but-present (leading, trailing or doubled comma), too long, or outside `[A-Za-z0-9_.:-]` | `environments_malformed` (the whole list is refused; entries are never skipped) |
| stored grant endpoint ≠ approved endpoint | `endpoint_mismatch` |
| stored grant environment ∉ approved list | `environment_mismatch` |

The comparison is exact string equality after the same `/mcp/` → `/mcp`
normalization the connect flow uses. A hostname suffix, a UI label, or a
substring is never accepted. `approved.t3coderelay.com.evil.example` is a
mismatch, and there is a test that says so.

Wire mapping in the existing vocabularies (no new public error codes):

| Action | Outcome | Reason |
|---|---|---|
| `t3Launch.launch` | `blocked` | `authorization_required` |
| `t3Send.send` | `rejected` | `authorization_required` |
| `t3Interrupt.interrupt` | `rejected` | `authorization_required` |

## Deliberate non-changes

- The **read** path (`t3OAuth.read`: environment, capabilities, projects,
  threads) is untouched. Read-only connections keep working with no new
  configuration.
- `convex/dispatch.ts` and `T3_MCP_URL_ISOLATED` are untouched. That is a
  different transport with a different credential source.
- There is no fallback to a privileged credential, no "warn and continue", and
  no per-call override: the only way to authorize a write is deployment
  configuration the owner controls.
- The existing read-only → operate boundary, owner-grant revalidation,
  connection-version checks, attempt reservation and reconciliation are
  unchanged.

## Configuration consequence — read this before DEV acceptance

Because the gate is fail-closed, **native writes are disabled on any deployment
where the two variables are not set**, including the current DEV deployment
until the owner configures them. That is intentional: an unconfigured
deployment must not inherit "whatever the current operate grant points at".

The owner must, in the Convex DEV deployment (`dev:hardy-warthog-60`):

1. Confirm the exact MCP endpoint of the **disposable** T3 instance approved
   for writes.
2. Read its environment id from `t3_environment_read` on that instance (not
   from a UI label).
3. Set `T3_NATIVE_WRITE_ENDPOINT` to that exact endpoint.
4. Set `T3_NATIVE_WRITE_ENVIRONMENTS` to that environment id (comma-separate
   more ids only if they are equally disposable).
5. Re-deploy/sync Convex and re-run the diagnostics. The env validator now
   reports both variables as required.

Do not point these at the real T3 relay for disposable testing. If isolated
acceptance needs a separate grant, deployment or owner identity, that is an
owner decision, not something this gate works around.

## Verification

- `convex/lib/writeTargetPolicy.test.ts` — 30 unit cases: unset, blank,
  malformed, multi-entry, normalization, exact endpoint equality, suffix
  lookalike, environment mismatch, no value echo.
- `convex/t3Launch.test.ts` — unconfigured, endpoint mismatch and environment
  mismatch each return `blocked` with **zero** MCP calls (not even a read); a
  multi-entry allowlist that includes the grant's environment still launches.
- `convex/t3Send.test.ts`, `convex/t3Interrupt.test.ts` — the same refusals
  before any connect/tool call.
- `convex/lib/envValidation.test.ts` — both variables are required and
  shape-checked.
- Full backend suite: 755 passed (43 files) on 2026-10-23.

## Remaining limitations

- The gate proves *destination identity*, not *disposability*. Whether the
  approved environment actually contains no production credentials or remotes
  is an owner/environment property that code cannot inspect.
- `launchAttempts` rows are not scoped by environment. Changing the approved
  environment does not invalidate historical attempts; the per-issue lock is
  still keyed on the Linear issue id.
- No live write was performed while implementing this gate.
