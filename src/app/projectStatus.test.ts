import { describe, expect, it } from "vitest";
import { displayConnectionStatus } from "./projectStatus";

describe("dashboard connection states", () => {
  const now = 100_000;
  const maxAgeMs = 10_000;
  it.each([
    [{ configured: false }, "blocked"],
    [{ configured: true }, "configured"],
    [{ configured: true, status: "connected", lastCheckAt: now }, "connected"],
    [{ configured: true, status: "connected", lastCheckAt: now - maxAgeMs - 1 }, "stale"],
    [{ configured: true, status: "disconnected", lastCheckAt: now }, "disconnected"],
    [{ configured: true, status: "blocked", lastCheckAt: now }, "blocked"],
  ] as const)("maps %# to %s", (input, expected) => {
    expect(displayConnectionStatus({ ...input, now, maxAgeMs })).toBe(expected);
  });
});
