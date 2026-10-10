import { describe, expect, it } from "vitest";
import { isValidT3ThreadId, MAX_T3_THREAD_ID_LENGTH } from "./threadIdentity";

describe("T3 thread identity validation", () => {
  it("accepts the observed bounded mcp UUID form", () => {
    expect(isValidT3ThreadId("mcp:58ee0336-b6be-489c-8462-3bc18246e5b3")).toBe(true);
  });

  it.each([
    "",
    " padded ",
    "line\nbreak",
    "mcp:not-a-uuid",
    "other:58ee0336-b6be-489c-8462-3bc18246e5b3",
    "mcp:58ee0336-b6be-489c-1842-3bc18246e5b3",
    "x".repeat(MAX_T3_THREAD_ID_LENGTH + 1),
    null,
    3,
  ])(
    "rejects malformed identifiers (%s)",
    (value) => expect(isValidT3ThreadId(value)).toBe(false),
  );

  it("rejects an otherwise valid identifier containing a configured alphabetic secret", () => {
    const id = "mcp:abcdef12-3456-4abc-8def-123456789012";
    expect(isValidT3ThreadId(id, "abcdef")).toBe(false);
  });
});
