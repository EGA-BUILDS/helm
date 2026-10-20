import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InterruptControl } from "../../src/features/t3/InterruptControl";
import type { InterruptResult } from "../../src/features/t3/interrupt";

/**
 * Isolated interrupt harness for the native interrupt browser tests (EGA-765).
 *
 * The interrupt traffic is stubbed per-test with `page.route`, so these prove
 * CLIENT behaviour only. No live T3 connection is involved.
 *
 * The point of this harness is the selection change: the owner picks a run,
 * arms a confirmation, and then the selected run changes *underneath* the
 * component. `InterruptControl` is rendered **without a `key`** on purpose — if
 * the confirmation were only invalidated by a remount, this harness would hide
 * that defect. The component must drop the armed confirmation from its props.
 */

const CONNECTION_ID = "c-1";
const PROJECT_ID = "t3-proj-1";
const THREAD_ID = "mcp:00000000-0000-4000-8000-000000000001";

const RUNS = [
  { runId: "run:thread:ordinal:1", runStatus: "running", label: "Run 1 (running)" },
  { runId: "run:thread:ordinal:2", runStatus: "running", label: "Run 2 (running)" },
] as const;

function Harness() {
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<InterruptResult[]>([]);
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
      <p data-testid="result-count">{`results:${results.length}`}</p>
      <p data-testid="last-outcome">{results.at(-1)?.outcome ?? "none"}</p>
      <p data-testid="selected-run">{run.runId}</p>
      <InterruptControl
        connectionId={CONNECTION_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        runId={run.runId}
        runStatus={run.runStatus}
        onDone={(result) => setResults((previous) => [...previous, result])}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
