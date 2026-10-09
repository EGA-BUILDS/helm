# T3 MCP transport contract - verified locally (EGA-677)

**Scope: LOCAL DISCOVERY ONLY.** Everything below was verified against the
T3 Code MCP server on this host through a loopback tunnel. **None of it is
evidence that Helm can reach T3 from Convex Cloud.** The token used here is
bound to a loopback resource and is **not** valid at any hosted URL.

Companion evidence: `fixtures/t3-mcp-tools.schemas.json` (all 80 tools with real
input schemas), `fixtures/t3-mcp-tools.sample.json` (names + descriptions only).

## Verified server identity

| Item | Value |
|---|---|
| Server | `T3 Code` |
| Version | `0.0.46-nightly.20261009.2873` |
| Protocol version | `2025-06-18` |
| Server capabilities | `logging`, `completions`, `tools{listChanged: true}` |
| Tool count | **80**, all 80 carrying an `inputSchema` |

## The transport contract that works

Use the official SDK transport. Do not hand-roll requests.

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL(resource), {
  requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
});
const client = new Client({ name: "helm-convex", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);          // performs initialize + initialized
const { tools } = await client.listTools();
```

The SDK handles the `MCP-Protocol-Version` header, the `Mcp-Session-Id` returned
by `initialize`, and `Accept`/`Content-Type` negotiation. Hand-written requests
to the same endpoint returned `400` with an empty body on `notifications/initialized`
and `tools/list` while `initialize` still returned `200`.

## Credential facts (verified against the installed binary)

- **The server accepts `Authorization: Bearer` only.** Its middleware is
  `authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : ""`,
  so a `DPoP` scheme yields an empty token and is rejected as
  `missing_bearer_token` (`401 invalid_mcp_credential`).
- `t3 auth session issue` tokens are **environment** sessions and are rejected
  by `authenticateMcpClient` with "Only MCP client sessions are accepted here."
  The OAuth authorization-code flow is the only route that yields a usable
  **MCP client** session.
- The issued token is `token_type: "Bearer"`, scope `orchestration:read`,
  `expires_in` 2592000 (30 days). Renewal is therefore long-lived, not a
  short TTL as first assumed.
- The server derives `issuer` and `resource` from the HTTP `Host` header, so the
  host used for registration, approval, exchange and MCP calls must be identical.
  `undici`'s `fetch` silently drops a `Host` override; `node:http` honours it.

## Owner approval flow (local)

```
POST /oauth/mcp/register     dynamic client registration
GET  /oauth/mcp/authorize    -> 302 /connect-agent
POST /oauth/mcp/approval     -> AuthMcpApprovalDetails (what the owner approves)
POST /oauth/mcp/decision     -> { redirectTo }   (redirectTo CONTAINS the code)
POST /oauth/mcp/token        -> AuthMcpTokenResult
```

- `AuthMcpApprovalDecision` is a tagged union:
  `deny {}` | `pairing-code {access, code}` | `browser-session {access, csrfToken}`.
- `AuthMcpClientAccess` = `read-only` | `approval-required` | `auto-accept-edits` |
  `auto` | `full-access`. Read-only discovery uses `read-only`.
- The token endpoint is `.pipe(asFormUrlEncoded())`: it requires
  `application/x-www-form-urlencoded`. A JSON body returns `415`.
- `AUTHORIZATION_CODE_TTL_MS = 60000` - **the authorization code lives 60
  seconds and is single use**, so capture and exchange must be automated with no
  human round-trip in between.
- Because `/oauth/mcp/decision` returns `redirectTo` containing the code, the
  code can be captured server-side without the browser redirect hop.

## What this does NOT establish

- **No Convex-to-T3 reachability.** The endpoint is loopback-bound. Convex Cloud
  remains unproven and unreachable from here (see `configuration-checklist.md`).
- **No hosted credential.** The token is bound to a loopback resource; a hosted
  URL requires its own registered redirect, issuer, resource and PKCE flow.
- **No launch, observation or dispatch proof.** Nothing beyond read-only
  discovery has been exercised.
- **No production readiness.** This is a personal development machine.

## Open for the hosted flow

Before any public path is proposed, the hosted URL's supported OAuth flow must
be verified independently: register with the hosted redirect/issuer/resource,
obtain owner approval for that exact host, exchange, then repeat
`initialize` + `tools/list` against the hosted endpoint. A loopback-bound token
says nothing about that.