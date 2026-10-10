# Helm configuration checklist (EGA-677)

Sanitized. Contains variable names, hosting location, purpose, required phase
and how the owner obtains each value. **No secret values appear here.**

## Summary

| # | Variable | Hosting location | Purpose | Required phase | How the owner obtains it |
|---|---|---|---|---|---|
| 1 | `NEXT_PUBLIC_CONVEX_URL` | Vercel + `.env.local` | Browser subscribes to Convex | Now (already set for dev) | `npx convex dev` prints it; copy the deployment URL. Public by design. |
| 2 | `NEXT_PUBLIC_CONVEX_SITE_URL` | Vercel + `.env.local` | Convex dashboard link for diagnostics | Now (already set for dev) | `npx convex dev` prints it. Public by design. |
| 3 | `CONVEX_DEPLOYMENT` | `.env.local` only | `npx convex dev` target selector | Now (already set) | Deployment name, e.g. `dev:NAME`. Not a credential. |
| 4 | `T3_MCP_URL` | Convex env settings (+ Vercel only if proxied) | Base URL of the T3 Code MCP endpoint (PRIVILEGED DISCOVERY ONLY — never used for dispatch, never a fallback for `T3_MCP_URL_ISOLATED`) | **EGA-677 blocker** | See "T3 endpoint" below. |
| 5 | `T3_MCP_TOKEN` | Convex env settings (secret) | Bearer credential for privileged T3 MCP discovery reads | **EGA-677 blocker** | `t3 auth session issue --scope orchestration:read --ttl ... --label ...` |
| 5a | `T3_MCP_URL_ISOLATED` | Convex env settings | ISOLATED T3 instance endpoint that dispatch may launch on. Dispatch reads ONLY this URL; valid absolute https, no embedded userinfo. Missing/invalid disables dispatch (fail closed). | **EGA-677 dispatch blocker** | The isolated instance's public HTTPS URL (owner-approved exposure path). |
| 5b | `T3_MCP_TOKEN_ISOLATED` | Convex env settings (secret) | Bearer credential for the ISOLATED T3 instance. Dispatch reads ONLY this token; no fallback to `T3_MCP_TOKEN`. Missing disables dispatch (fail closed). | **EGA-677 dispatch blocker** | `t3 auth session issue` against the isolated instance, least-privilege scopes. |
| 5c | `T3_PROJECT_ID_ISOLATED` | Convex env settings | Trusted T3 project identity allowed for isolated dispatch. Dispatch is disabled unless the caller's project exactly matches this server-side binding. This is not `LINEAR_PROJECT_ID`. | **EGA-679 mapping pending** | Obtain the project identity from the isolated T3 project configuration; do not infer it from a caller or Linear. |
| 6 | `LINEAR_API_KEY` | Convex env settings (secret) | Server-side Linear GraphQL reads | EGA-679 | Linear > Settings > Account > Security & Access > Personal API keys. **When creating it, choose the `Read` permission and limit it to the target team** - a personal key defaults to *full* access to the creating user's data unless restricted. |
| 7 | `LINEAR_PROJECT_ID` | Convex env settings | Target Linear project UUID | EGA-679 | Linear > Settings > Projects, or the project URL / `projectId`. |
| 8 | `CLERK_FRONTEND_API_URL` | Convex env settings | Clerk issuer for identity validation | EGA-678 | Clerk dashboard > API Keys > Frontend API URL. Configure the Development instance URL in Convex DEV only. |
| 9 | `HELM_OWNER_SUBJECT` | Convex env settings | The single allowed owner identity | EGA-678 | The approved immutable `user_…` subject from the Clerk Development dashboard. Bind it with the issuer server-side; never accept it from a client. |

Nothing prefixed `NEXT_PUBLIC_` may hold a secret: it is inlined into the
browser bundle. Server credentials live only in Convex environment settings.

## Installed T3 contract (verified on this host, 2026-10-09)

| Item | Observed value |
|---|---|
| OpenCode engine | `opencode v2.0.26` |
| T3 Code CLI | `t3 v0.0.46-nightly.20261009.2873` |
| T3 Connect | Exposure enabled, stored credential, environment link provisioned, relay `https://relay.t3.codes` |
| MCP endpoint | `http://127.0.0.1:3773/mcp` (resource name "T3 Code") |
| Auth model | OAuth 2.1: dynamic client registration, `authorization_code` + PKCE `S256`, **DPoP**-bound tokens, `bearer_methods_supported: ["header"]` |
| MCP scopes | `orchestration:read`, `orchestration:operate` |
| Credential issuance | `t3 auth session issue` (bearer) or `t3 auth pairing create` (one-time, for the interactive `/connect-agent` approval) |
| Credential expiry | TTL-bound (`--ttl`); e.g. `5m`, `1h`, `30d`. Expiry is the renewal lifecycle: there is no refresh grant. |

### Authentication behaviour actually observed

- Unauthenticated `POST /mcp` -> `401 invalid_mcp_credential`, with
  `WWW-Authenticate: Bearer resource_metadata=.../.well-known/oauth-protected-resource/mcp`.
- A token from `t3 auth session issue` presented as `Bearer` **and** as
  `DPoP` was both rejected with `invalid_mcp_credential`. Live T3 Connect
  sessions are listed with method `dpop-access-token`; the CLI-issued session
  is `bearer-access-token` and is not accepted by `/mcp`.
- `GET /oauth/mcp/authorize` returns `302` to an interactive `/connect-agent`
  approval page. **A self-signed DPoP proof is therefore not sufficient** -
  either the CLI token is not the right credential class, or the token must be
  minted through the interactive approval flow first.

### The approval step is owner-interactive (confirmed)

Local investigation of the installed server (`t3 v0.0.46-nightly.20261009.2873`):

- `POST /oauth/mcp/decision` exists (wrong shapes return `400`, not `404`;
  `/oauth/mcp/approve`, `/grant`, `/pending` are all `404`).
- The web bundle shows the pairing UI posts a **pairing code** to the backend
  (`{host, pairingCode}`), and the page renders a "Pairing token" field. The
  approval is driven by that UI, not by a documented machine-callable API.
- `t3 auth pairing create --base-url <url>` prints a ready link of the form
  `http://127.0.0.1:3773/pair#token=<credential>`. Opening it in a browser and
  approving is the owner-side approval.
- No `t3` CLI subcommand performs a headless approval of an MCP authorization
  request; `t3 auth pairing create` only *mints* the code.

**Consequence:** a Convex action cannot self-approve. The owner must approve once,
locally, in a browser. Only after that does a usable DPoP-bound credential exist.

### Linear API authentication (inspected)

- Endpoint: `https://api.linear.app/graphql` (GraphQL, POST).
- Header: `Authorization: <personal-api-key>` - a personal API key is sent
  **raw, without a `Bearer ` prefix**. OAuth 2.0 tokens use the `Bearer` form;
  Helm's F3 reads use a personal key.
- Personal keys are created under Settings > Account > Security & Access (or
  Settings > Administration > API for member keys, if that setting is enabled).
  Per Linear's docs, a personal key can be granted **full** access or restricted
  to specific permissions (`Read`, `Write`, `Admin`, `Create issues`, `Create
  comments`) and limited to specific teams. Restrict to `Read` + the target
  team. Mutations are not needed for F3 (read-only), and v0.1 has no writeback.

### Hosted reachability: PROVEN UNREACHABLE

Probed from the hosted Convex runtime (`eu-west-1`) with the internal-only
`probeEndpointReachability` action:

| Candidate | Result |
|---|---|
| `http://127.0.0.1:3773/mcp` | unreachable (3 ms - loopback is the Convex container) |
| `http://100.92.43.100:3773/mcp` (Tailscale) | `unreachable-timeout` (8.0 s) |
| `http://84.8.223.52:3773/mcp` (public IP) | `unreachable-timeout` (8.0 s) |
| `https://convex.cloud` (positive control) | **reachable**, HTTP 301 in 134 ms |

The Tailscale address is in `100.64.0.0/10` (CGNAT, `is_global == False`) and
is therefore **not sufficient** for a hosted Convex action. The public IP does
not answer on 3773 because no public listener/proxy maps to that port (nginx
serves other hostnames only). The egress control proves the probe is sound, so
this is a genuine connectivity gap, not a probe defect.

## Linear hosted authentication: VERIFIED

Proven on `dev:hardy-warthog-60` from the hosted Convex runtime via the
internal-only `verifyHelmProjectAccess` action:

| Field | Result |
|---|---|
| `authentication` | verified |
| `projectAccess` | verified |
| `issuesAccess` | verified |
| `configuredProjectMatchesHelm` | true |
| `moreIssuesAvailable` | true |
| `error` | null |

Both `LINEAR_API_KEY` and `LINEAR_PROJECT_ID` are set (verified by name only).
This was re-run after the owner rotated the key and returned the same result.

> **Handling note:** `npx convex env list` prints secret values in plaintext.
> Check presence without values using
> `npx convex env list | cut -d= -f1`. Never paste that output anywhere.

## The one decision that unblocks EGA-677

Helm needs a **supported HTTPS path from Convex Cloud to this host's T3 MCP
server**. Candidate options, all requiring owner authorization:

1. **Authorize a public HTTPS reverse proxy to `127.0.0.1:3773`** (an nginx
   `server_name` + TLS, or a dedicated cloudflared ingress hostname pointing at
   3773). Requires a real FQDN with a certificate. Exposes the MCP endpoint to
   the public internet, so the OAuth/DPoP layer and least-privilege scopes
   become the only thing standing between the internet and the coding runtime.
   Highest risk; needs explicit approval.
2. **A relay/proxy the owner controls** that Convex can reach and that forwards
   to `127.0.0.1:3773`. Keeps the runtime private; the relay is the new trust
   boundary.
3. **Run the T3 MCP server on a host Convex can already reach** (not recommended
   for this MVP - TRD forbids a second execution server).

Not viable: Tailscale-only exposure; binding 3773 to `0.0.0.0` without a proxy
and certificate; passing a CLI bearer token before its acceptance is confirmed.

## Owner grant bootstrap (EGA-678)

`grantOwner` is an `internalMutation`: no browser session can call it, so the
very first grant must be created by the operator from trusted server tooling
after `CLERK_FRONTEND_API_URL` (#8) and `HELM_OWNER_SUBJECT` (#9) are set in
the Convex environment. The mutation refuses any subject/issuer pair that does
not match that server-side configuration. Placeholders only — never a real
subject, issuer, or secret:

```sh
npx convex run internal.auth.grantOwner '{"subject":"user_YOUR_OWNER_SUBJECT","issuer":"https://YOUR_CLERK_ISSUER"}'
```

Find the owner subject (`user_…`) in the Clerk dashboard under Users → the
owner user → User ID, and the issuer under API Keys → Frontend API URL. The
same command re-grants after rotation (the revision bumps by one); revocation
is `npx convex run internal.auth.revokeOwner '{"subject":"user_YOUR_OWNER_SUBJECT"}'`.
Until the first grant exists, every owner check fails closed with
`unauthorized` — that lockout is the expected state, not a bug.

## Order of operations

1. Owner picks a connectivity option and provides `T3_MCP_URL`.
2. Owner confirms which credential form `/mcp` accepts, then provides
   `T3_MCP_TOKEN` (issued server-side, stored in Convex env only).
3. Run hosted discovery (`discoverCapabilities`) and record real tool schemas,
   provider/model catalog and permission modes in `doc/t3-capabilities.md`.
4. Recheck reachability + credential renewal, then one authorized disposable
   launch. Reconcile ambiguous outcomes before any retry.
