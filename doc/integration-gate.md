# Helm integration gate report - EGA-677

> Verdict: **BLOCKED - hosted T3 execution proof not authorized/provisioned.**
> EGA-677 is **In Progress, not Done.** No capability is claimed that was not
> observed, and no isolation is weakened to force a pass. Companion record:
> `t3-capabilities.md`; Linear shape sample: `fixtures/linear-relations.sample.json`.

## Context

EGA-676 (foundation build fix) is done and pushed to `main`. EGA-677 must prove
the installed T3 runtime contract from a **hosted Convex action** before any
dependent coding dispatch (EGA-681+) is built. The relevant capability exists
on this machine (`t3 connect` / `t3 serve` / `t3 pair` / `t3 auth`, opencode
2.0.26, t3 0.0.46-nightly) but it is **not provisioned for hosted use**, so the
hosted proof cannot be executed safely without owner authorization. Doing
otherwise (e.g. exposing the local coding runtime over an ad-hoc tunnel and
handing its credential to Convex) would be an insecure shortcut this gate
explicitly forbids.

## Acceptance-item gate status

| # | EGA-677 acceptance item | Status | Evidence / note |
| -- | -- | -- | -- |
| 1 | Record exact target mapping, owner grants, selected usable provider/model, safe acceptance issue | **BLOCKED** | Target mapping and grants are owner inputs (PRD Open Questions: "Which repository, Linear project and T3 project form the first target?"). Not supplied. Provider/model catalog not discoverable without hosted discovery. |
| 2 | Hosted authenticated discovery, isolated launch, observation, reconnect/renewal against actual T3 | **BLOCKED** | No hosted T3 Connect endpoint + credential provisioned. Capability (`t3 connect`) exists; authorization/provisioning is owner action. |
| 3 | Lost-acknowledgment fault-injected; prove correlation or validated manual exact-thread/no-launch inspection | **BLOCKED** | Requires a live launch to inject the loss. Deferred until item 2 passes. |
| 4 | Runtime/repository controls: useful coding enabled; push/merge/deploy require owner authorization | **BLOCKED** | Requires a live target + proof of isolated-workspace permission mode. Deferred. |
| 5 | Linear read access, pagination, blocker statuses proven; canceled/unreadable blockers handled | **PARTIAL (read proven)** | Paginated reads across the 10 Helm issues + relations + docs + comments succeeded via the `linear` MCP this session (sanitized shape in fixtures). App-side **server-side** Linear read + canceled/unreadable *enforcement* belong to EGA-679/EGA-680 and need a read-only API key. |
| 6 | Save version/capability fixtures + this gate report; resolve callback/credential-storage questions | **PARTIAL** | Fixtures + report saved (this file, `t3-capabilities.md`, fixtures). Credential-storage question is an **open owner decision** (see below), not resolved. |
| 7 | Record owner scope/TRD decisions + gate approval; report unsupported capability as a blocker | **DONE (report)** | This report is the blocker record. Gate approval remains the owner's. |

**Net:** the gate does **not** pass. Per the plan's gate rule, dependent
execution features (F4 launch dispatch in EGA-681 and anything that would call
T3) must **not** be implemented against invented T3 capabilities. Independent
UI-only work not blocked by this gate may proceed.

## What IS proven (usable now, sanitized)

- Helm's own repo builds + runs a public health query (EGA-676).
- Linear read shape: pagination, `blocks`/`blockedBy` direction, `statusType`
  categories (`completed` vs `canceled` vs `started`) - the inputs F3/F4 need.
- T3 supported remote surface exists: `t3 connect`/`serve`/`pair`/`auth`.

## Required owner actions to open the gate (the blocker checkpoint)

1. **Provision T3 Connect for hosted use.** Authorize and set up a stable HTTPS
   endpoint (`t3 connect`, or `t3 serve` + `t3 pair` + `t3 auth`; decide Tailscale
   vs public tunnel). Provide Helm's Convex env the endpoint URL + a headless
   credential via secure setup (not in source). Confirm reconnect-per-action and
   credential renewal behavior.
2. **Server-side Linear credential.** A personal API key, read-only, minimum
   scope, for the configured Linear project (TRD: "Server-side personal API key
   with minimum required read access").
3. **First execution target mapping.** repo + base ref, Linear project id, T3
   environment + project id/path.
4. **Safe disposable prepared issue** (owner-authorized) for the real launch +
   observation proof.
5. **Usage budget** for the pilot.
6. **Isolated-workspace permission mode**: local code/test/commit allowed;
   push/merge/deploy require human authorization, validated before real use.
7. **Credential-storage decision (EGA-677 step 3):** if renewal material must
   persist, store it authenticated-encrypted under a versioned env key with a
   revision-checked renewal lease; never log tokens; keep secrets out of source,
   browser bundles, logs and Linear comments.

## Next action

Once items 1, 3, 4 are provided, run the hosted Convex discovery probe
(`discoverCapabilities()` candidates), then a single owner-authorized isolated
launch + observation + reconnect + lost-acknowledgment fault injection, and flip
each BLOCKED row above to PASS with sanitized evidence. Until then EGA-677 stays
In Progress and EGA-681+ execution features stay gated.
