import { createRoot } from "react-dom/client";
import { ExecutePanel } from "../../src/features/execute/ExecutePanel";

/**
 * Isolated execute-panel harness for attempt-recovery browser tests. The
 * panel's preflight, recovery and launch traffic is stubbed per-test with
 * `page.route`, so these prove client behaviour across a REAL browser
 * reload (module-level browser storage is empty after `page.reload()`).
 */

const issue = {
  id: "issue-1",
  identifier: "EGA-681",
  title: "Native launch recovery",
  url: "https://linear.app/helm/issue/EGA-681",
  priority: 2,
  priorityLabel: "High",
  state: { id: "s-1", name: "In Progress", type: "started" as const },
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  assignee: null,
  description: "Ship the launch.",
  acceptanceCriteria: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

createRoot(document.getElementById("root")!).render(
  <main>
    <ExecutePanel issue={issue} linearProjectId="proj-1" linearTeamId="team-eng" />
  </main>,
);
