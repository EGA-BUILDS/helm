# EGA-811 — cross-project thread overview contract

Status: implemented on `feat/ega-811-t3-project-thread-overview`. This note is the
hand-off contract for **EGA-815**; it is not a second registry and it does not
change the native T3 read path.

## What the overview owns

The All-projects view is a projection of data Helm already reads:

- `projects` — the loaded `t3_project_list` page(s) for the active connection.
- `threadPages` — one `ReadState<Page<Thread>>` per
  `projectScopeKey(connectionId, projectId)`.
- `threadScope` — the generation token shared by every thread query.
- `threadQuery` / `threadStatuses` — in the All-projects view these are
  **local** filters over loaded rows; they do not change what T3 was asked to
  read and do not bump `threadScope`.
- `summarizeThreadCoverage(...)` — the only source of the coverage receipt. It
  returns loaded projects, loaded pages, known totals, unknown totals, partial
  state and per-project cursors. The aggregate `Page.total` is never presented
  as a workspace total unless every known project was read and every project
  reported a total.

Thread identity is always `(connectionId, projectId, threadId)`. Two projects
may legitimately return the same upstream thread id or title; they remain two
rows, two detail slots and two selections.

## Intentional behaviour

- No `t3_thread_read` fan-out. Only the opened thread mounts `AttentionBadge`
  (one attention read) and `t3_thread_read` (one activity read).
- A failed project page is retried only by an explicit owner action. The
  fan-out effect does not loop on the same failure.
- Overlapping pages use `mergeThreadPage`: row position is stable, while a
  repeated identity is replaced by newer trustworthy thread evidence. A valid
  `updatedAt` decides; an unknown timestamp never displaces a known one; equal
  or both-unknown timestamps use the later page as the tie-break. Cursor, total
  and freshness always come from the page just read. A true first-page refresh
  is not a continuation page and EGA-815 must keep that distinction.
- Changing a **server-side** filter (selected-project search/status) clears
  cached pages and bumps `threadScope`, so old rows cannot merge into the new
  result set. Changing a view clears cached pages for the same reason.
- A status of `active`, `idle`, `pending_start`, `pending_cleanup`, `stale`,
  `archived`, an unknown string or `null` is **Unknown**. It is not treated as
  running and never as an approval request. `needs-attention` requires one of
  the explicit native statuses `waiting_for_approval`, `awaiting_approval`,
  `pending_approval`, `awaiting_input`, `waiting_for_input`, `needs_input`,
  `action_required`, `blocked` or `paused`. Pending approvals are only assessed
  on the opened thread.
- `overviewRequests` and `pagingRequests` are scoped to one lifecycle
  generation: connection + view + `threadScope`. A generation change aborts and
  clears both before starting the new reads. A normal page success does not
  cancel sibling reads.

## EGA-815 extension points

EGA-815 may add bounded incremental polling without rebuilding this layer:

1. Re-read the selected project page with the cursor already stored in
   `threadPages[projectScopeKey(...)]`, or re-read the first page of a bounded
   fan-out (`CAP` in `useT3Dashboard.ts`).
2. Dispatch `threads/ready` with the **same** `threadScope` and the same
   connection/project identity. The reducer merges by identity and rebuilds the
   aggregate; it already drops pages from an older scope.
3. Do not increment `threadScope` for a poll. Scope changes mean "this is a
   different query"; polls are the same query.
4. Do not poll `t3_thread_read` for every thread. Poll the list, then reload
   the selected thread's activity through the existing `reloadActivity` path.
5. Keep concurrency bounded and abort in-flight requests on connection loss or
   any lifecycle-generation change. Register polls with the same generation as
   `overviewRequests` / `pagingRequests`; an old poll must never delete or
   overwrite a newer generation's controller.
6. Poll through `mergeThreadPage`, not the generic `mergePage`, so a changed
   thread status updates the existing row without changing its position or
   inventing a total.
7. If polling needs an explicit action, add a `threads/refresh` action rather
   than reusing `thread/query` or `thread/statuses`; those two intentionally
   change local filter state and may clear selected-project pages.

EGA-815 must not turn this into an always-on dashboard poller, a new store, a
transcript mirror, or an N-thread attention scan.

## EGA-815 selected-thread live refresh (implemented extension)

Status: implemented on `feat/ega-815-selected-thread-auto-refresh`. This is a
bounded browser loop, not a daemon, scheduler, queue, websocket or transcript
store. It never writes to T3.

### Selected activity

- One loop exists only for the explicitly selected thread. It starts only when
  the tab is visible, the connection is authorized, the **fresh detail** reports
  a confirmed `running` native status, and T3 returned an incremental
  `nextPosition`. A continuation (`hasMore === true`) is not a pause reason: the
  native first page starts at the OLDEST item and `afterPosition` walks forward,
  so a thread longer than one page starts with a continuation and the loop walks
  one page per tick until it reaches the tail. A caught-up forward read returns
  `nextPosition: null`; the last known position is preserved, so an idle
  running thread keeps its bounded cadence instead of losing its cursor. `Load more` advances the same
  cursor faster; both share one in-flight slot.
- The only incremental cursor is the native `nextPosition` passed back as
  `afterPosition`. `updatedAt` and `nextTextOffset` are never reused as cursors;
  `nextTextOffset` remains the truncated-text continuation cursor.
- A result is merged with `appendDetail` → `mergeActivity`, which deduplicates by
  activity id and orders by native position. A repeated item is replaced, never
  appended twice. The thread/project/connection identity is checked again in the
  reducer, so the same thread id in another project cannot be mixed in.
- One selected-activity request is in flight at a time. Poll, initial read,
  manual Refresh and Load more share that slot. A selection/connection/project
  change, hidden tab, unmount or manual Refresh aborts the request and clears
  the timer before a new loop can start.
- Base cadence is 15 seconds. A failed attempt waits 30 seconds, then doubles,
  capped at 120 seconds. A valid `Retry-After` on 429/503 is forwarded by the
  adapter, clamped by the policy, and can only extend the exponential delay —
  never shorten it. A non-retryable failure (`access_denied`, `revoked`,
  `connection_expired`, `misconfigured`) clears private state where required and
  stops the loop with terminal copy; it is not retried. A 5xx/429 without a Helm
  JSON envelope stays retryable from its HTTP status.
- `lastObservedAt` is written only by a successful read. A failed attempt keeps
  the previous observation and records the error/failure count. The UI never
  presents a timer tick or a failed read as a successful heartbeat.
- Pause reasons are explicit: hidden, disconnected, inactive (terminal or
  waiting), unknown (idle/active/archived/pending/unrecognized), not loaded,
  no-cursor and stopped (a non-retryable failure with no timer). A quiet thread
  is never treated as running or as a pending approval.

### Summary

- A separate 60-second loop refreshes only the loaded first page of a project
  whose page has no continuation cursor. In All-projects mode it is capped at
  the same six-project fan-out; it never calls `t3_thread_read` for a row and
  never retries a project whose initial read failed.
- In selected-project mode the summary forwards the active `titleContains` and
  `statuses` filters; an All-projects filter is local to loaded rows and is not
  sent upstream.
- Summary success dispatches `threads/ready` with the same `threadScope` and
  `source: "refresh"`. It merges through `mergeThreadPage`, preserves the
  previous continuation cursor (so a first-page refresh cannot make Load more
  repeat pages already on screen), and does not clear an explicit Load more busy
  flag. It never consumes a continuation page.
- A non-retryable summary failure stops the loop and renders terminal copy; a
  retryable failure backs off from the 60-second base.

### Preserved behaviour

Manual Refresh continues from the loaded selection's native `nextPosition`, so
it appends only items the browser has not seen and cannot replace a loaded
multi-page timeline with the oldest first page; a selection with no loaded page
gets a full first-page read. Load more uses the existing
`hasMore`/`nextPosition` path; truncated text still uses `itemId` +
`nextTextOffset`. None of these paths change the native read/write allowlist or
add a backend route.
