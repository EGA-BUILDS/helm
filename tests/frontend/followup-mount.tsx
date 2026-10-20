import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FollowUpControl } from "../../src/features/t3/FollowUpControl";

/**
 * Isolated follow-up harness for the native follow-up browser tests.
 *
 * The send traffic is stubbed per-test with `page.route`, so these prove
 * CLIENT behaviour only: the idempotency key discipline, the stale-result
 * discard, the acknowledgement callback and the absence of any send on
 * mount. No live T3 connection is involved.
 */

const THREADS = [
  {
    connectionId: "c-1",
    projectId: "t3-proj-1",
    threadId: "mcp:00000000-0000-4000-8000-000000000001",
    title: "Thread A",
  },
  {
    connectionId: "c-1",
    projectId: "t3-proj-2",
    threadId: "mcp:00000000-0000-4000-8000-000000000002",
    title: "Thread B",
  },
];

function Harness() {
  const [index, setIndex] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const thread = THREADS[index]!;
  return (
    <main>
      <label>
        Selected thread
        <select
          aria-label="Selected thread"
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
        >
          {THREADS.map((entry, position) => (
            <option key={entry.threadId} value={position}>
              {entry.title}
            </option>
          ))}
        </select>
      </label>
      <p data-testid="accepted-count">{`accepted:${accepted}`}</p>
      <FollowUpControl {...thread} onAccepted={() => setAccepted((count) => count + 1)} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
