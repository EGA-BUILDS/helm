import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions are tested with @edge-runtime/vm per Convex guidelines.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
});
