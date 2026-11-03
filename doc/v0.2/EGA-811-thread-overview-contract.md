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
- Overlapping pages merge by `threadIdentity`, so a repeated boundary row is
  replaced rather than appended.
- Changing a **server-side** filter (selected-project search/status) clears
  cached pages and bumps `threadScope`, so old rows cannot merge into the new
  result set. Changing a view clears cached pages for the same reason.
- A status of `active`, `idle`, `stale`, `archived`, an unknown string or
  `null` is **Unknown**. It is not treated as running and never as an approval
  request. `needs-attention` requires an explicit waiting/paused/blocked/input
  native status. Pending approvals are only assessed on the opened thread.

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
5. Keep concurrency bounded and abort in-flight requests on connection loss.
   The existing `overviewRequests` ref is the place to register/poll the
   All-projects reads.
6. If polling needs an explicit action, add a `threads/refresh` action rather
   than reusing `thread/query` or `thread/statuses`; those two intentionally
   change local filter state and may clear selected-project pages.

EGA-815 must not turn this into an always-on dashboard poller, a new store, a
transcript mirror, or an N-thread attention scan.
