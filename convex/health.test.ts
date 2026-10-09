/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Per convex/_generated/ai/guidelines.md: build the module registry with
// import.meta.glob and drive functions through generated api references.
const modules = import.meta.glob("./**/*.ts");

test("health.check returns { status: 'ok' } with no arguments and no auth", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.health.check, {});
  expect(result).toEqual({ status: "ok" });
});
