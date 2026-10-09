# Helm development contract

Owner decision: 2026-10-09. This repository is the canonical initial MVP codebase.

## Owner-authorized development workflow — 2026-10-09
Build Helm in /home/ubuntu/projects/helm and publish verified incremental commits directly to main at https://github.com/EGA-BUILDS/helm. No feature branch or PR approval is required for this initial personal MVP. One writer/integration stream at a time; do not launch parallel editors against the same checkout.
Before each commit inspect git status/diff and preserve unrelated local work. Fetch origin/main and integrate safely; never reset --hard, force-push or overwrite someone else's commit. If the VM has uncommitted Convex setup, preserve it when incorporating incoming docs. Run relevant checks before pushing, then record commit SHA/checks in the issue.
Main is Vercel's production branch: pushes can trigger deployment. Keep owner authorization, environment separation and dispatch-disabled safeguards intact. Repository push permission is not proof of a successful hosted deployment. Runtime permissions for repositories Helm later executes against remain explicitly configured; this workflow does not silently change their merge/push policy.


## Before implementation
Read AGENTS.md, relevant installed Next.js docs and convex/_generated/ai/guidelines.md when present. Preserve generated Next.js/Convex guidance. Read the assigned Linear issue and docs/PRD.md, docs/TRD.md and docs/IMPLEMENTATION_PLAN.md. Do not infer an external T3 tool schema or permission from these documents.

Remote main at the start of this handoff contained only starter commit c0aecd02aae85dae5a6ca28a0884b54e91c8580a. User-provided VM evidence shows local Convex changes and a failed updated production build; health:check passed. This documentation commit does not transfer those dirty VM files, fix the build or complete any feature. EGA-676 owns their reconciliation and repair.

## Canonical facts and ownership
Linear owns planned issues and blocking relations. T3 owns actual threads, turns, workspace and coding activity. Convex owns launch intent, immutable snapshots, command/slot state, observations and notes. Next.js renders authorized safe views. Owner notes are not runtime evidence.

## Proposed caller contracts
These are application-side contracts; installed runtime schemas remain authoritative.

- prepareLaunch(issueId, settings) returns fresh readiness and a deterministic digest. Owner confirms objective/criteria/context/base for that digest.
- launchIssue({ issueId, settings, digest, requestId }) returns a durable attempt reference. A repeated identical request returns the same intent; a changed payload with the same ID is rejected.
- getExecution(attemptId) returns requested settings, actually observable settings, exact thread reference, latest saved facts/freshness and manual notes. Missing fields stay unavailable.

## Invariants
Backend owner authorization on every sensitive public function; background functions internal with explicit stored grant checks. One occupied Hub slot is transactionally enforced, including pending, waiting and uncertain outcomes. External launch is never treated as atomic with a Convex mutation. Finished turn is not verification, merge or shipment. Independent external T3 work remains outside the Hub capacity limit.

## Failure and concurrency
Reserve command/snapshot/slot and schedule dispatcher in one mutation. Claim pending command before calling T3. Unknown writes are reconciled, never blind-retried. Observer generation prevents stale response overwrite; observer lease expiry cannot free coding capacity. Only fresh confirmed inactivity allows release. Previously linked resumed work is rechecked before another dispatch.

One code writer publishes at a time. GitHub head contention requires a new fetch/integration, not force-push. Do not treat a production deploy failure as successful release.

## Migration and verification
Apply additive compatible backend changes before frontend uses their functions. Preserve prior attempts/commands. Keep preview/dev separate from production. During initial main deployment, unfinished sensitive functionality remains protected and dispatch disabled until required grants/UAT pass.

For each issue: authored-source lint, standalone TypeScript check, production build, relevant meaningful tests and actual integration/browser checks when its criteria require them. Do not run real coding launches in ordinary CI. Record tested commit and external evidence; unresolved criteria remain blocked.

## Tradeoffs and alternative
We accept direct-main integration and its automatic deployment coupling in exchange for one initial code stream. We accept manual lost-response resolution where the proven upstream contract lacks correlation in exchange for avoiding duplicate remote coding. A feature-branch/PR workflow is deferred by explicit owner choice, to revisit before real users. A second execution server is rejected because T3 owns that runtime.

## Open integration questions
Which target will Helm first execute against? Which hosted auth/renewal, isolated workspace and correlation fields does installed T3 support? Which owner identity and usage budget are approved? EGA-677 resolves execution capability questions; EGA-678 configures identity. Do not invent answers.

## Current next action
Start EGA-676 on the VM, preserve local Convex setup, incorporate this handoff and repair the provider prerender boundary.

