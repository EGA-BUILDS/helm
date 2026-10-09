import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Convex output (convex/_generated/**). Convex rewrites these files
    // on every push, so their lint warnings cannot be fixed in this repo and
    // they must not fail authored-source lint runs.
    "convex/_generated/**",
  ]),
]);

export default eslintConfig;
