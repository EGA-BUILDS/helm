import { createRoot } from "react-dom/client";
import { NativeT3Dashboard } from "../../src/features/t3/Dashboard";

createRoot(document.getElementById("root")!).render(
  <><p style={{ margin: 0, padding: 8, background: "#faf1e4", font: "12px sans-serif" }}>Isolated frontend test harness. Owner authentication is not exercised here.</p><h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>Helm</h1><main><NativeT3Dashboard accountControls={<span>Test account slot</span>} serviceStatus={null} /></main></>,
);
