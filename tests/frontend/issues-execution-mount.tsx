import { createRoot } from "react-dom/client";
import { LinearIssueBrowser } from "../../src/features/linear/IssuesPanel";

/**
 * Mounts the REAL Linear issue browser container, including the execution
 * review it arms from a genuine issue selection. Every `/api/*` call is stubbed
 * per-test with `page.route`, so these prove the mounted product path — issue
 * selection → review → explicit launch — without a live Linear or T3
 * connection and without a real write.
 */
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24 }}>
    <LinearIssueBrowser />
  </main>,
);
