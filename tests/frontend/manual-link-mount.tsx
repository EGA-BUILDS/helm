import { createRoot } from "react-dom/client";
import { ManualLinkControl } from "../../src/features/t3/ManualLinkControl";

const CONNECTION_ID = "c-1";
const PROJECT_ID = "t3-proj-1";
const THREAD_ID = "mcp:00000000-0000-4000-8000-000000000001";

function Harness() {
  return (
    <main>
      <ManualLinkControl
        connectionId={CONNECTION_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        threadTitle="Manual link thread"
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
