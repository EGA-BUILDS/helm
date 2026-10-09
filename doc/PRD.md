> **Owner decision, 2026-10-09:** Verified incremental Helm development commits may be pushed directly to main. This supersedes older branch/PR recommendations in this document; it does not waive evidence, private auth, environment separation or runtime target permission requirements. Main pushes may trigger Vercel deployment; keep unfinished dispatch disabled. All unrelated technical/release sign-offs remain pending.

> Published to Helm on 2026-10-09. Original reviewed specification preserved; approvals remain pending. Repository is now [https://github.com/EGA-BUILDS/helm](<https://github.com/EGA-BUILDS/helm>); dev Convex setup exists, but current updated Next.js build fails. Refer to project overview and issues for current execution status. Local relative document links identify source filenames; use the sibling Linear documents for reading.

# PRD: Helm — First Usable MVP

| Field | Value |
| -- | -- |
| Owner | Abdelilah Mortaki (EGAWILLDOIT) |
| Status | In review — ready for implementation handoff; owner release sign-off pending |
| Target release | v0.1 — one focused implementation day, conditional on T3 integration feasibility |
| Last updated | 2026-10-09 |
| Links | Repository, design and Linear implementation issue: not created yet. Related document: PROJECT_EXECUTION_HUB_ARCHITECTURE_PLAN.md |

> **Rule:** If a feature isn't listed in Section 4, it isn't in the build.

This PRD defines the agreed first usable slice. It supersedes the broader product PRD for this release's implementation scope only; feature-level autonomy remains a later product goal. The one-day target is an estimate, not a delivery guarantee.

---

## 1. Problem & Goal

**Problem:** The owner prepares software issues in ChatGPT and Linear, then switches to T3 to start coding work and inspect progress. There is no central view connecting an issue to its execution, latest activity, blockers and previous attempts.

**Goal:** Use a private application to select one prepared Linear issue, launch one ordinary T3 thread with a supported provider/model, follow its recorded progress and retain execution history. Continue reviewing code, testing and approving Git operations in T3 and existing repository tools.

**Success metrics** (measured during release acceptance):

| Metric | Today | Target | How measured |
| -- | -- | -- | -- |
| Real issue executed from the Hub | No Hub execution demonstrated | One real prepared issue launched and observed | Owner acceptance session with issue ID and T3 thread ID |
| Duplicate launch from repeated clicks | Untested | One logical execution; no second dispatch for the same request | Double-click and refresh test |
| Recovery from uncertain launch | Untested | Unknown result is visible and blocks a blind retry | Simulated lost-response test |
| Browser-independent history | No Hub history demonstrated | Execution and notes remain after closing and reopening | Separate authenticated browser session |
| Truthful completion display | Untested | Zero verified/merged/shipped claims inferred from a finished thread | Observe a completed thread without independent delivery evidence |

---

## 2. Users

| User | Who they are | What they want |
| -- | -- | -- |
| Owner | EGAWILLDOIT, working with one existing project and T3 environment | Start a prepared issue, see progress and blockers, then continue work in T3 |

No additional users, invitations, teams or administrator interface in v0.1.

---

## 3. Scope

**In scope (this release):**

* F1: Private owner login.
* F2: One project and its Linear/T3 connections.
* F3: Read-only Linear issue list and readiness check.
* F4: Launch one issue with supported provider/model selection.
* F5: Live execution observation and T3 handoff.
* F6: Manual blocker and next-action notes.
* F7: Persistent execution history.

**Out of scope (explicit non-goals):**

* Planning chat, AI requirements generation and creating/editing Linear issues.
* Automatic feature scheduling, dependency graphs and background dispatch of the next issue.
* Multiple active top-level issue executions, subagent controls and automatic provider fallback.
* Advanced reasoning settings, runtime policy editing and workspace management UI.
* In-app Git review, push/merge approvals, automated verification and deployment tracking.
* Linear milestone writeback, webhook-based issue synchronization and automatic checkpoint generation.
* In-app cancellation or resumption: use T3 for these operations, then the Hub observes resulting state.
* Multiple projects/environments, billing, notifications, analytics and curated project summaries.

---

## 4. Features

### F1: Private owner login

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Access project information and execution controls privately.
* **User story:** As the owner, I want private login so that other users cannot see or operate my project.
* **How it works:**
  1. Sign in using Clerk; allow only the configured owner identity.
  2. Authenticate Convex calls and check ownership in backend functions.
  3. Provide sign-out and a signed-out view.
* **Edge cases & errors:** Unauthenticated, expired or unapproved identities receive no private data and cannot dispatch work.
* **Done when (acceptance criteria):**
  - [ ] The owner can sign in and sign out.
  - [ ] A signed-out browser cannot read issues, history or connection secrets.
  - [ ] A different authenticated identity cannot read owner data or launch work through direct backend calls.
* **Not included:** Signup workflow, invitations, roles and custom authentication forms.

### F2: One project and connected services

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Use the correct Linear project and existing T3 checkout.
* **User story:** As the owner, I want one configured project so that an issue is dispatched to the intended repository.
* **How it works:**
  1. Configure one project name, repository reference, Linear project ID, T3 environment and T3 project ID/path during deployment.
  2. Configure Linear credentials server-side; complete T3 authentication through its supported connection flow.
  3. Show connection health, last successful check and actionable failure messages.
  4. Keep a small settings page with project information and connection checks.
* **Edge cases & errors:** Wrong project, expired authorization or unreachable T3 disables launch; do not silently choose another project/environment.
* **Done when (acceptance criteria):**
  - [ ] The app shows the configured project and matching Linear/T3 identities.
  - [ ] Connection checks perform real reads and distinguish last-known health from current failure.
  - [ ] Launch is blocked when the configured target cannot be validated.
  - [ ] Credentials never appear in browser payloads, activity text or error output.
* **Not included:** Multi-project setup, credential-management UI, new VM provisioning or a second execution server. The minimal supported T3 OAuth callback may be implemented where required.

### F3: Linear issue list and readiness

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Pick an issue with enough instructions to execute safely.
* **User story:** As the owner, I want issue details and blockers visible so that I know what I am launching.
* **How it works:**
  1. Read issues from the configured Linear project on import or explicit refresh, with pagination.
  2. Show identifier, title, status, priority and description; retain acceptance criteria within the original description.
  3. Show blocking issue references and their current Linear status. Only blockers in a completed status count as resolved; canceled blockers require the dependency to be removed or corrected in Linear.
  4. Before launch, refresh the selected issue and blocker records. Require a nonempty title and description, then separate owner confirmations for a clear objective, testable acceptance criteria, sufficient context and required predecessor changes present in the intended base. Store confirmation against the refreshed issue revision. Completed or canceled selected issues cannot launch; prepare/reopen the issue in Linear first.
  5. Save the exact issue snapshot used for execution.
* **Edge cases & errors:** An API error retains the last snapshot with its age and disables launch until a successful preflight. Any blocker not in a completed status prevents launch, including canceled blockers. An unreadable blocker prevents launch rather than being treated as resolved. Missing/empty instructions or a failed owner readiness confirmation prevents launch.
* **Done when (acceptance criteria):**
  - [ ] Imported identifiers, descriptions, priorities and blockers match Linear.
  - [ ] Large issue lists are paginated rather than silently truncated.
  - [ ] Unresolved, canceled or unreadable blockers disable launch and explain the required correction in Linear.
  - [ ] Completed/canceled selected issues cannot launch; blank instructions and missing readiness confirmations disable launch.
  - [ ] If issue data changes after confirmation, launch requires confirmation of the refreshed revision.
  - [ ] Readiness confirmation and issue snapshot are retained with the execution.
  - [ ] Issue edits in Linear appear after refresh without overwriting earlier execution snapshots.
* **Not included:** Automatic semantic scoring or extracting acceptance criteria into a new format. Linear completion is a preflight signal, not proof that a predecessor's code is integrated; the owner must confirm the base contains required changes.

### F4: Launch one issue

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Start coding without manually reconstructing issue context in T3.
* **User story:** As the owner, I want to select a provider/model and launch an issue so that T3 receives its prepared instructions.
* **How it works:**
  1. Discover available provider/model options through the supported T3 interface; do not hardcode a model catalog.
  2. Select a supported pair and display the target project and workspace behavior.
  3. Create a durable execution/command record before external dispatch; atomically reserve the one active execution slot. Persist a stable request ID and payload fingerprint so retries reuse the same command. Revalidate target, selected issue revision, readiness and provider/model immediately before dispatch.
  4. Start one ordinary top-level thread in an isolated workspace using the proven T3 operation. Send the issue ID, snapshot, acceptance criteria, relevant context and instruction to leave a blocker handoff.
  5. Record the acknowledged thread identity and returned provider/model. Show requested and observed settings separately when T3 cannot independently expose the actual configuration. Start in a supported permission mode that requires human approval for sensitive operations. State that the agent may implement, test and commit locally but may not push, merge or deploy without the owner’s authorization; validate the runtime and repository controls before real use.
  6. If launch acknowledgment is lost, show a Resolve launch action: recheck T3, attach the exact existing thread after validating project/environment, or record that the owner inspected T3 and confirmed no launch occurred. Record the owner, time and supporting reference. An unresolved outcome retains the slot; a button click alone cannot mark it safe to retry.
* **Edge cases & errors:** Repeated clicks reuse the same launch request. A lost response produces an unknown outcome that blocks relaunch until correlated with T3 or resolved by the owner. Model/auth errors do not trigger fallback. If isolated launch is unsupported, the integration gate fails; a different workspace strategy requires an explicit PRD change. The permission mode must not depend on approving routine work through an unsupported external approval API; the owner can answer in T3.
* **Done when (acceptance criteria):**
  - [ ] One real issue starts in the intended isolated T3 workspace with the selected provider/model.
  - [ ] Only one Hub execution can occupy the active slot, including pending, running, waiting-for-input and unknown states; simultaneous requests from two tabs cannot bypass backend enforcement.
  - [ ] The app does not claim to limit threads the owner independently starts in T3.
  - [ ] Refreshing or double-clicking does not create another launch command.
  - [ ] An ambiguous launch never automatically dispatches a replacement thread.
  - [ ] Failed requests, unsupported options and unknown outcomes are clearly visible.
  - [ ] Thread identity, requested settings, observed settings when exposed, target and issue snapshot are saved durably; unavailable observed fields are labeled unavailable.
  - [ ] An uncertain launch can be rechecked and explicitly reconciled through the app without deleting history or blindly redispatching.
  - [ ] A new issue can launch after T3 confirms the previous Hub execution is idle following a finished turn, failed or interrupted; waiting-for-input and unreachable states do not release the slot.
* **Not included:** Subagent permissions, advanced model options, automatic pushes/merges, provider fallback and launching the next issue.

### F5: Live execution page and T3 handoff

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Understand what the agent is doing and continue detailed work in T3.
* **User story:** As the owner, I want current observed activity and a T3 reference so that I can follow execution without losing its issue context.
* **How it works:**
  1. Display issue reference, thread reference, provider/model, workspace/branch when exposed, latest activity and last observation time.
  2. Short background actions observe active executions; Convex subscriptions update the page from saved observations.
  3. Show launch pending, running, waiting for input, turn finished, failed, interrupted or unknown only when supported by observed data. Freshness is a separate indicator. A turn is one submitted coding request; a thread can contain later turns. A finished turn is not a permanently closed thread or a completed issue. Unavailable distinctions remain unknown.
  4. Once a linked thread is observed idle after a finished turn, failed or interrupted, release its Hub launch slot and stop routine polling. Refresh on page open or explicit Refresh. Before a later Hub dispatch, recheck prior linked threads for resumed work; if any is running or awaiting input, block the new launch. Other independently created T3 threads are outside this cap.
  5. Provide a supported T3 link. If T3 offers no deep link, show the environment/project/thread ID with a clear copy-and-open path.
  6. The owner reviews code, tests, sends follow-ups, stops/resumes work and authorizes Git operations through T3 or repository tools.
* **Edge cases & errors:** Unreachable T3 marks observations stale and preserves the last known state. A finished turn is labeled Turn finished — review in T3, not verified, merged or shipped. Canceling a Hub observer must not be presented as canceling T3 work.
* **Done when (acceptance criteria):**
  - [ ] Activity and state come from the actual linked thread.
  - [ ] While pending/running/waiting for input, schedule observation every 60 seconds without depending on an open browser. Display last successful observation and errors; label data stale after 120 seconds without a successful observation. These are application targets, not guarantees of external service response time.
  - [ ] A connection outage does not release the execution slot; reconnecting reconciles the original thread before allowing new dispatch.
  - [ ] Closing the browser does not stop background observation or the remote coding thread.
  - [ ] Reopening restores the page and last saved observations.
  - [ ] The owner can locate the exact execution in T3 using the displayed reference.
  - [ ] Finishing a turn never creates a verification, integration or delivery claim.
  - [ ] Explicit Refresh observes external stop/resume/follow-up changes and updates the same thread record. A later resumed turn is shown without overwriting earlier saved milestone observations.
* **Not included:** Full transcript mirroring, token-level streaming, test-evidence ingestion and in-app send/stop/resume controls. Changing the observation target requires a recorded PRD change; it cannot be silently weakened to pass acceptance.

### F6: Blocker and next-action notes

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Preserve why work stopped and what to do next.
* **User story:** As the owner, I want a saved blocker note so that I can return and continue without reconstructing the situation.
* **How it works:**
  1. Add/edit a note containing completed work, blocker, remaining work and recommended next action.
  2. Optionally include branch/commit, files and supporting references copied from T3.
  3. Save actor and timestamp, and show the note beside observed execution status.
* **Edge cases & errors:** A failed save is visible and retains unsaved text. Owner notes do not overwrite the actual T3 state or claim to be automatically captured checkpoints.
* **Done when (acceptance criteria):**
  - [ ] A blocker and next action can be saved against an execution.
  - [ ] The saved note and timestamp survive reopening the app.
  - [ ] Manual notes are clearly distinguished from observed activity.
  - [ ] Empty blocker/next-action fields cannot be saved as a blocker note; failed saves preserve entered text for retry.
* **Not included:** Automatic checkpoint generation, resumable agent handoff logic and Linear writeback.

### F7: Persistent execution history

* **Priority:** Must
* **Who uses it:** Owner
* **What they're trying to do:** Find previous attempts and return to unfinished work.
* **User story:** As the owner, I want execution history so that I can see what happened to an issue across sessions.
* **How it works:**
  1. List executions with issue ID/title, provider/model, start time, observed status, freshness and blocker note summary.
  2. Open the corresponding execution detail and launch-time issue snapshot.
  3. Allow a new manually launched attempt only after the previous execution is confirmed inactive under F4/F5 and preflight passes again. Reuse the existing thread for follow-ups through T3; a new Hub launch creates a separate attempt.
* **Edge cases & errors:** Repeated attempts remain separate records. A lost/removed T3 thread leaves history intact and marks the external reference unavailable.
* **Done when (acceptance criteria):**
  - [ ] Every acknowledged, failed or uncertain launch has a visible durable history entry.
  - [ ] Thread IDs, snapshots, timestamps and notes survive sign-out, refresh and backend redeployment.
  - [ ] A new attempt cannot replace or silently overwrite an earlier one.
  - [ ] Unknown outcomes retain the active slot until explicitly reconciled using F4’s resolution flow.
* **Not included:** Advanced search, history export, analytics or indefinite retention of complete transcripts.

---

## 5. Non-Functional Requirements

| Area | Requirement |
| -- | -- |
| Performance | Paginate issue/history lists and bound activity payloads. Live observation target is defined in F5; no unsupported page-load guarantee |
| Security | Owner authorization enforced in Convex; HTTPS; server-side secrets; validated integration responses; safe project/target restrictions |
| Reliability | Durable dispatch records and atomic slot reservation; no blind retry of external launch; scheduler retries/redeployment cannot redispatch an acknowledged or unknown command; browser closure cannot stop observation |
| Data integrity | Store issue snapshots and observed facts separately from owner notes; scheduler restart cannot create another active attempt |
| Languages / locale | English UI; timestamps displayed in Africa/Casablanca with underlying timestamps stored consistently |
| Devices / browsers | Desktop Chrome is the primary acceptance browser; basic usable responsive layout |
| Accessibility | Labeled inputs, keyboard-accessible buttons, visible focus and status communicated through text rather than color alone |
| Availability | No SLA for this personal MVP; show service outages and stale data explicitly |
| Cost | Poll only active executions; retain launch snapshots, configuration, notes and milestone states until owner deletion is separately implemented. Retain at most the latest 100 activity excerpts per attempt, each at most 4 KiB. Measure pilot usage; free hosting is not an acceptance promise |

---

## 6. Dependencies & Integrations

| Dependency | Why needed | Owner | Status |
| -- | -- | -- | -- |
| Next.js/TypeScript + Vercel | Hosted interface | Implementing agent / owner | Proposed; not provisioned for this application |
| Convex | Data, subscriptions, actions and durable observation scheduling | Implementing agent / owner | Selected; application deployment not yet demonstrated |
| Clerk | Owner identity | Owner / implementing agent | Proposed; configuration required |
| Linear read access | Issue details and blocker status | Owner | Integration for this application untested |
| Existing T3 VM and external MCP | Provider discovery, isolated launch and observation | Owner | Existing service reported; installed capabilities and hosted access unverified |
| Convex Workflow component | Bounded orchestration if needed; ordinary durable scheduler may suffice for observation | Implementing agent | Proposed; use only where it simplifies the seven features |
| Repository permissions and target checkout | Safe real execution and human-controlled Git operations | Owner | Must be checked before first launch |

v0.1 does not require Git/CI/deployment API integrations. These tools remain the owner's manual review and shipping surfaces.

---

## 7. Milestones & Phasing

| Phase | Features | Target date |
| -- | -- | -- |
| Integration gate | Minimal hosted T3 authentication, discovery, isolated launch, observation and ambiguous-outcome probe supporting F2/F4/F5 | Start of implementation day; stop dependent work if infeasible |
| Core usable application | F1, F2, F3, F4 | Same focused implementation day, conditional on gate passing |
| Return-to-work experience | F5, F6, F7 | Same day target |
| Owner acceptance | Full one-issue flow, permissions and recovery checks | Before release |
| Later product releases | Feature scheduling, parallelism, supported delegation, verification/integration/delivery evidence | Separately scoped; not part of this build |

Prefer simple screens: issue list/project home, execution detail/history and compact connection settings. Do not build the broader product's five full dashboards in this release. If the integration gate fails, report the precise gap and revise the estimate; a mock T3 launch does not satisfy release acceptance.

---

## 8. Risks & Assumptions

**Assumptions:**

* The owner can provide deployment access, integration credentials, a working T3 environment and one safe prepared issue.
* Installed T3 supports hosted authentication, required thread reads and isolated launch.
* The selected provider/model is usable with current credentials; discovery alone is not proof of readiness.
* Manual review and Git authorization outside the Hub are acceptable for this first release.
* A one-day build is feasible only if the critical integration works early.

**Risks:**

| Risk | Impact | Mitigation |
| -- | -- | -- |
| T3 hosted authentication or isolated launch is unsupported | High | Prove first; never substitute a mock or silently change workspace strategy |
| Launch accepted but response lost | High | Persist command; reconcile by proven correlation or manual resolution; block relaunch |
| Owner marks Linear blocker done while code is absent from base | High | Explicit owner base-readiness confirmation; automated integration proof deferred |
| Credentials expire or services become unreachable | High | Clear connection/staleness errors; stop new dispatch; retain history |
| Agent shipping instruction is ignored | High | Repository credentials/protection enforce allowed operations; shipping remains human-controlled |
| Polling/log volume exceeds budget | Medium | Bounded observation, no token transcript mirroring; inspect actual pilot usage |
| MVP grows into the full platform during implementation | High | Section 4 is the build boundary; defer unlisted controls |

---

## 9. Open Questions

| Question | Owner | Due | Answer |
| -- | -- | -- | -- |
| Which repository, Linear project and T3 project form the first target? | Owner | Before integration gate | Not supplied for this application |
| Does installed T3 support isolated launch and reliable launch correlation? | Implementing agent | Integration gate | Must be established with actual version and evidence |
| What is the supported hosted MCP authentication/renewal flow? | Implementing agent / owner | Integration gate | Unverified; implement the supported route |
| Which prepared issue will be used for real acceptance? | Owner | Before acceptance | Choose a bounded, safe change |
| What owner identity should be allowed? | Owner | Before private deployment | Clerk is the proposed implementation default; configure one immutable owner identity server-side |
| What personal usage budget should the pilot stay within? | Owner | Before routine use | Not set; record measured usage first |

Resolve these during setup; do not stall unrelated interface work on optional preferences. Runtime feasibility, target identity and authorization are release blockers.

---

## 10. Definition of Done (whole release)

- [ ] All seven Must features pass their acceptance criteria.
- [ ] The app is deployed privately and usable by the owner with real integrations.
- [ ] The owner selects a real Linear issue, confirms readiness, chooses a supported provider/model, launches it, observes progress and locates its exact T3 thread.
- [ ] The owner saves a blocker/next-action note and sees it again after closing and reopening the app.
- [ ] Double-click, concurrent-tab launch, lost-response reconciliation, canceled/unreadable blocker, changed-issue revision, stale connection and unauthorized-backend-call checks pass.
- [ ] A finished turn releases its Hub slot only after confirmed inactivity; externally resumed linked work prevents another launch at preflight.
- [ ] Supported runtime permissions and repository controls keep push/merge/deployment human-controlled in the acceptance environment.
- [ ] The app retains execution history through browser sessions and backend redeployment.
- [ ] No thread-completion state claims code verification, merge, deployment or shipment.
- [ ] Manual review/testing and Git authorization remain available through T3 and repository tools.
- [ ] Non-functional requirements are verified, pilot usage is recorded and blocking open questions are resolved.
- [ ] Owner signs off after using the real one-issue flow.

Release handoff includes the deployed URL, setup instructions, supported T3 capability/version record, acceptance results and known limitations. This document is a specification; none of these checks are claimed to have passed yet.

---

## 11. Change History

| Date | Change | By |
| -- | -- | -- |
| 2026-10-09 | Initial v0.1 PRD using the supplied template; seven-feature one-day scope and explicit release gates | ChatGPT, for owner review |
| 2026-10-09 | Devil’s advocate revision: explicit launch reconciliation, canceled-blocker rules, confirmation invalidation, turn/slot lifecycle, observed settings and bounded activity retention; all 11 template sections preserved | ChatGPT, for owner review |

