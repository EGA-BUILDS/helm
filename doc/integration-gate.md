# Helm integration gate report - EGA-677

> **Verdict: BLOCKED.** EGA-677 stays **In Progress, not Done.** One owner
> decision (a supported public path from Convex Cloud to the T3 MCP endpoint)
> is the only remaining gate. No capability is claimed that was not observed, and
> no isolation is weakened to force a pass.
>
> Companion documents: `configuration-checklist.md` (per-variable setup),
> `t3-capabilities.md` (runtime facts), `fixtures/linear-relations.sample.json`
> (sanitized Linear shape).

## Correction to the earlier gate report

An earlier revision of this document stated that T3 Connect was "not
provisioned". That was **incorrect**. `t3 connect status` reports exposure
enabled, a stored credential, a provisioned environment link, and relay
`https://relay.t3.codes`. The actual blocker is narrower and different: the
T3 MCP endpoint is **loopback-only**, so the hosted Convex runtime cannot reach
it. That distinction matters because it changes the fix from "authorize T3
Connect" to "provide a supported public path to port 3773".

## Verified runtime contract

| Item | Observed | How verified |
|---|---|---|
| OpenCode engine | `opencode v2.0.26` | `opencode --version` |
| T3 Code CLI | `t3 v0.0.46-nightly.20261009.2873` | `t3 --version` |
| T3 Connect | exposure enabled; stored credential; environment link provisioned; relay `https://relay.t3.codes` | `t3 connect status` |
| MCP endpoint | `http://127.0.0.1:3773/mcp` (resource name "T3 Code") | probe + RFC 9728 metadata |
| Auth model | OAuth 2.1: dynamic client registration, `authorization_code` + PKCE `S256`, **DPoP**-bound tokens, `bearer_methods_supported: ["header"]` | `.well-known` documents; live `initialize` attempts |
| MCP scopes | `orchestration:read`, `orchestration:operate` | protected-resource metadata |
| Renewal | TTL-bound (`--ttl`); **no refresh grant** advertised | `--help` + metadata |

`127.0.0.1:40465` is the OpenCode web UI (an SPA catch-all that answers 200 on
any path). It is **not** the MCP endpoint.

## Negative results that must not be glossed over

- A token from `t3 auth session issue` was rejected by `/mcp` when presented as
  `Bearer` **and** as `DPoP` (`invalid_mcp_credential`). Live T3 Connect
  sessions are listed with method `dpop-access-token`; the CLI issues
  `bearer-access-token`. **The accepted credential form is not yet proven** and
  must be confirmed by the owner before a credential is stored.
- `GET /oauth/mcp/authorize` returns `302` to an interactive `/connect-agent`
  approval page. Automated approval was deliberately not attempted.
- `https://relay.t3.codes` serves `/health` but returns `404` for
  `/.well-known/oauth-protected-resource/mcp` and `/mcp`; it is not a general
  purpose MCP bridge for arbitrary clients.

## Hosted reachability: PROVEN UNREACHABLE

Measured from the hosted Convex runtime (`eu-west-1`) using the internal-only
`probeEndpointReachability` action:

| Candidate | Observed |
|---|---|
| `http://127.0.0.1:3773/mcp` | unreachable, 3 ms (loopback is the Convex container) |
| `http://100.92.43.100:3773/mcp` (Tailscale) | `unreachable-timeout`, 8.0 s |
| `http://84.8.223.52:3773/mcp` (public IP) | `unreachable-timeout`, 8.0 s |
| `https://convex.cloud` (positive control) | **reachable**, HTTP 301, ~130 ms |

The Tailscale address `100.92.43.100` lies in `100.64.0.0/10` and reports
`is_global == False`, so **a private Tailscale address is not sufficient** for a
hosted Convex action. The public IP does not answer on 3773 because no public
listener or proxy maps to that port. The positive control proves hosted egress
works, so this is a genuine connectivity gap rather than a probe defect.

## Acceptance-item gate status

| # | EGA-677 acceptance item | Status | Evidence / blocker |
| -- | -- | -- | -- |
| 1 | Record exact target mapping, owner grants, selected usable provider/model, safe acceptance issue | **Partial** | Helm's own repo (`EGA-BUILDS/helm`) recorded. First execution target, grants and safe issue remain owner inputs (PRD Open Questions). Provider/model catalog needs hosted discovery. |
| 2 | Hosted authenticated discovery, isolated launch, observation, reconnect/renewal | **BLOCKED** | Endpoint is loopback-only; no supported path from Convex Cloud. Credential form also unproven. |
| 3 | Lost-acknowledgment fault injection; correlation or validated manual no-launch inspection | **BLOCKED** | Requires a live launch to inject the loss; depends on item 2. |
| 4 | Runtime/repository controls: useful coding, but push/merge/deploy need owner authorization | **BLOCKED** | Requires a live target and proof of the isolated-workspace permission mode; depends on item 2. |
| 5 | Linear read access, pagination, blocker statuses proven; canceled/unreadable handled | **Partial** | Real paginated reads, relations direction and `statusType` categories captured in `fixtures/linear-relations.sample.json`; auth transport inspected. Server-side Linear reads and canceled/unreadable *enforcement* need `LINEAR_API_KEY` (EGA-679/680). |
| 6 | Save version/capability fixtures and gate report; resolve credential-storage questions | **Partial** | Runtime facts, checklist, fixtures and this report saved. Credential storage is now answerable: **T3 credentials are TTL-bound with no refresh**, so "renewal" is re-issuance, and the storage decision is a versioned env key with revision-checked replacement and no logging. |
| 7 | Record owner scope/TRD decisions and gate approval; report unsupported capability as a blocker | **Done (report)** | This document is the blocker record. Gate approval remains the owner's. |

## Decision required from the owner (one step)

Provide a **supported HTTPS path from Convex Cloud to this host's T3 MCP
server**, either:

1. **Public HTTPS reverse proxy** to `127.0.0.1:3773` (an nginx `server_name`
   with TLS, or a dedicated cloudflared ingress hostname). Exposes the endpoint
   to the public internet, so OAuth/DPoP plus least-privilege scopes become the
   only barrier between the internet and the coding runtime. Highest risk;
   needs explicit approval.
2. **Owner-controlled relay/proxy** reachable by Convex that forwards to
   `127.0.0.1:3773`. Keeps the runtime private; the relay becomes the trust
   boundary. Preferred where a proxy is acceptable.

Rejected: running a second execution server (TRD forbids it), Tailscale-only
exposure, binding 3773 to `0.0.0.0` without TLS, and storing a CLI bearer token
before its acceptance is confirmed.

Once the endpoint is reachable, the remaining sequence is: confirm the accepted
credential form -> provide `T3_MCP_TOKEN` -> hosted discovery
(`discoverCapabilities`) -> recheck renewal -> one authorized disposable launch
-> lost-acknowledgment fault injection -> flip each BLOCKED row above to PASS
with sanitized evidence. No dependent F4 dispatch feature will be built before
that point.