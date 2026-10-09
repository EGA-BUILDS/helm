# Linear blocking relationships — verified directly via GraphQL (EGA-677 task 1)

This supersedes the earlier "relations are write-only" blocker, which was an artifact of
the MCP `get_issue` surface rather than a Linear limitation. Verified from **hosted
Convex** against `https://api.linear.app/graphql` using the Convex-held
`LINEAR_API_KEY`. The key is never returned or logged.

Controlled fixtures were created in a dedicated project `P-EGA-677 Proof Fixtures`;
no real Helm issue was modified, and all fixtures were canceled afterward.

## Verdict

**Blocking relationships are fully readable in both directions, with working
pagination.** Dependency direction does **not** need to be redesigned around
`get_issue`'s missing fields.

## Direction semantics

`Issue` exposes two relation connections:

| Field | Meaning | Node shape observed |
|---|---|---|
| `relations` | outgoing — issues **this** issue acts on | `relatedIssue` = the other side |
| `inverseRelations` | incoming — issues acting on **this** issue | `issue` = the other side, `relatedIssue` = this issue |

Worked example (dependent `EGA-697`, seven blockers `EGA-690`–`EGA-696`):

```
EGA-690.relations        -> blocks EGA-697     (forward, from a blocker)
EGA-697.inverseRelations -> issue=EGA-696     (the blocker)
                            relatedIssue=EGA-697
```

### The trap worth knowing

On an `inverseRelations` node, **`relatedIssue` is the dependent itself, not the
blocker.** The blocker identity is on `issue`. An earlier probe read only
`relatedIssue` and concluded the relation pointed at itself — it had read the wrong
side of the edge. Any dependency logic must read `issue` on inverse nodes.

## Pagination

`inverseRelations(first: 2)` walked to completion:

| Page | Items | `hasNextPage` |
|---|---|---|
| 1 | 2 | true |
| 2 | 2 | true |
| 3 | 2 | true |
| 4 | 1 | false |

7 items collected, 7 unique, no duplicates, cursor monotonic, `hasNextPage` accurate.
Same connection shape as issue pagination.

## Two write-side findings that affect a dispatcher

### 1. Batch relation writes can partially apply

`save_issue({ blockedBy: ["EGA-686","EGA-687","EGA-688"] })` returned success, but on
read-back **only one of the three** relations existed.

Writing the same seven relations **one at a time** persisted **7 of 7**.

So: write one relation per call, and read back to verify. A success response from a
batched relation write is not evidence the relations exist.

### 2. Error surface is better than the MCP surface

An unreadable blocker fails loudly and atomically, naming the offender:

```
blockedBy: ["EGA-99999"]  ->  Could not find issue "EGA-99999" for blockedBy
```

GraphQL validation errors are also specific — a wrong field returned
`Cannot query field "status" on type "Issue". Did you mean "state"?`, which is far more
actionable than the MCP layer's silent `null`s.

## GraphQL probe design

`convex/integration/linearGraphql.ts` is an **internal action** that:

- reads `LINEAR_API_KEY` from the environment and never returns it;
- rejects any document containing `mutation`, and any `variables` payload containing
  the word, so it cannot be repurposed into a write path;
- sends Linear personal API keys bare (`Authorization: <key>`, no `Bearer` prefix);
- returns status, a bounded body slice, and a normalized `errorClass`.

## Impact on the gate

Criterion 5's dependency-direction blocker is **resolved**. Remaining open items are
unchanged: credential renewal, and the push-permission blocker.