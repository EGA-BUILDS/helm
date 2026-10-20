import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InterruptControl } from "../../src/features/t3/InterruptControl";

/**
 * Reset-regression harness for the native interrupt control (EGA-765 D1).
 *
 * Distinct from the shared `interrupt.*` harness: this one additionally
 * toggles the last-observed run status (a confirmation must also be cleared
 * by a runStatus refresh) and can hold the interrupt response in flight so
 * the late arrival of run A's outcome can be checked against run B.
 *
 * `InterruptControl` is rendered without a `key` on purpose: if the armed
 * confirmation were only invalidated by a remount, this harness would hide
 * the defect.
 */

const CONNECTION_ID = "c-reset";
const PROJECT_ID = "t3-proj-1";
const THREAD_ID = "mcp:00000000-0000-4000-8000-000000000001";

const RUNS = [
  { runId: "run:thread:ordinal:1", status: "running", label: "Run 1" },
  { runId: "run:thread:ordinal:2", status: "running", label: "Run 2" },
] as const;

function Harness() {
  const [index, setIndex] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [results, setResults] = useState<number>(0);
  const run = RUNS[index]!;
  return (
    <main>
      <label>
        Selected run
        <select
          aria-label="Selected run"
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
        >
          {RUNS.map((entry, position) => (
            <option key={entry.runId} value={position}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Mark waiting"
          checked={waiting}
          onChange={(event) => setWaiting(event.target.checked)}
        />
      </label>
      <p data-testid="result-count">{`results:${results}`}</p>
      <p data-testid="selected-run">{run.runId}</p>
      <InterruptControl
        connectionId={CONNECTION_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        runId={run.runId}
        runStatus={waiting ? "awaiting_input" : run.status}
        onDone={() => setResults((previous) => previous + 1)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
