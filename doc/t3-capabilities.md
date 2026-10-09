# T3 capability record - EGA-677 discovery (sanitized)

> Status: **discovery only**. The hosted Convex-to-T3 proof is **not** complete
> (see `integration-gate.md`). Nothing below claims an upstream tool schema,
> permission, or launch capability that was not actually observed. No secrets,
> tokens, keys, account IDs or personal data are recorded here.

## Discovered runtime (this machine, 2026-10-09)

| Item | Observed value | Source |
| -- | -- | -- |
| OpenCode (T3 engine) version | `opencode v2.0.26` | `opencode --version` |
| T3 Code CLI + child version | `t3 v0.0.46-nightly.20261009.2873` | `t3 --version` |
| T3 CLI remote subcommands | `connect`, `serve`, `pair`, `auth`, `--tailscale-serve` | `t3 --help` |
| Local T3 Code HTTP/WS server | running on loopback (`127.0.0.1:3773`); tunnels on `20241/20242` (loopback) and `20243` (cloudflared) | `ss -ltnp` |
| Hosted HTTP MCP endpoint for Convex | **not provisioned** (no `T3_CONNECT_URL`/token in env, `.env.local`, or repo) | env + file scan |

`t3 connect` is documented as "Set up T3 Connect for this machine"; `t3 serve`
runs the HTTP/WebSocket server headless and prints pairing details; `t3 pair`
mints a pairing token; `t3 auth` manages the local auth control plane for
headless deployments. This is the **supported remote-invocation surface** the
TRD calls "Supported HTTP MCP via T3 Connect". It is available but **not yet
authorized/provisioned with a stable server-only credential**, so a hosted
Convex action cannot authenticate to it today.

## Two distinct T3 integration surfaces (do not conflate)

1. **Agent-side orchestration MCP (this session only).** The coding agent
   harness injects orchestration tools (delegated tasks/child threads, thread
   lifecycle, worktree selection, scheduling, webhooks, secrets, PR linking,
   preview/queue). These drive *this* session. They are **not** a reusable
   hosted HTTP API, must not be treated as the app's execution contract, and
   cannot be called by a Convex cloud action.
2. **Hosted HTTP MCP via T3 Connect (what Helm needs).** A Convex action would
   reach a provisioned, authenticated T3 Connect endpoint to discover, launch,
   and observe threads. This requires owner-authorized provisioning
   (`t3 connect` + `t3 auth`/`pair`) and a durable credential with renewal -
   **not present**.

## Linear read surface (observed, sanitized)

Linear integration used in this session provides (via the `linear` MCP/SDK):
issue read (`get_issue`), listing (`list_issues`), relations
(`includeRelations` -> `blocks`/`blockedBy`), comments (`list_comments`),
documents, and pagination cursors on list endpoints. Status categories are
distinguished by `statusType` (`unstarted`, `backlog`, `started`, `completed`,
`canceled`, `duplicate`), which is what readiness/blocker logic must key on.
A trimmed sample of the real blocking-direction shape is in
`fixtures/linear-relations.sample.json`. For the app, Linear must be read
**server-side** with a personal API key scoped to minimum read access
(TRD "Connected Systems") - **not yet provisioned for this application.**

## Proposed application adapter contract (proposed names only - not upstream claims)

Per TRD/EGA-677, Helm's app-side T3 adapter is intended to expose these pure
TypeScript operations over the proven hosted interface. Names are Helm's, not a
claim about any upstream tool. Implementation is deferred until the hosted
contract in `integration-gate.md` is proven.

```ts
// Proposed (unimplemented) Helm-side contract
interface T3Adapter {
  discoverCapabilities(): Promise<CapabilityRecord>;      // version, provider/model catalog, permission modes
  validateTarget(target: TargetMapping): Promise<ValidationResult>; // project/env/base + controlled permissions
  startIssueThread(input: LaunchInput): Promise<Receipt>;           // one isolated top-level thread
  readThread(ref: ThreadRef): Promise<ThreadObservation>;           // normalized state + activity
  correlateLaunch(req: RequestFingerprint): Promise<ThreadRef | null>; // best-effort; may require owner reconciliation
}
```

## Open capability questions (owner/implementer to resolve in EGA-677)

- Does installed T3 expose **hosted authenticated** discovery/launch/observe
  with a stable credential **and** renewal? (`t3 connect` + `t3 auth` path is
  the candidate; must be proven, not assumed.)
- **Isolated workspace/thread** launch and its permission mode that requires
  human approval for sensitive Git ops (push/merge/deploy) while allowing local
  code/test/commit.
- **Reconnect/renewal** behavior across hosted action invocations (the app must
  reconnect per action; no assumed persistent socket - TRD "Solution strategy").
- **Correlation/deep-link** availability for lost-acknowledgment reconciliation.
- Supported **provider/model catalog** identifiers and selection.

## Blocked items (see integration-gate.md for required owner actions)

Hosted discovery, isolated launch, observation, reconnect/renewal,
fault-injection of lost acknowledgment, and any disposable-target proof are
**blocked** until the owner authorizes and provisions a T3 Connect endpoint +
credential and a safe disposable target. They will not be simulated or
approximated.
