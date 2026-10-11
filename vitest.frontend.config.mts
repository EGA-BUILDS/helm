import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/features/t3/**/*.test.ts", "src/features/t3/**/*.test.tsx"],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
