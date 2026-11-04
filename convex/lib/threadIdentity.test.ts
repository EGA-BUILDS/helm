import { describe, expect, it } from "vitest";
import {
  isValidT3ThreadId,
  isValidT3ThreadIdRead,
  MAX_T3_THREAD_ID_LENGTH,
  MAX_T3_THREAD_ID_READ_LENGTH,
} from "./threadIdentity";

const LEGACY = "mcp:58ee0336-b6be-489c-8462-3bc18246e5b3";
const BARE_UUID = "5e476b4f-047e-4d72-bbfc-15d9498d31e4";
const LAUNCH = `mcp:launch:${"a".repeat(64)}`;
const DELEGATED =
  "thread:delegated-task:command%3Amcp%3A6a3438e6-1f36-46fc-9940-4966e6d273df%3Adelegate-task%3A3676395b-913d-4bb5-887e-9fb3089e4bb2";
const DELEGATED_SLUG =
  "thread:delegated-task:command%3Amcp%3A83a86eb6-f4c3-450c-b47c-ce99650fff59%3Adelegate-task%3Aega-820-verify-1";
const PROVIDER_INSTANCE =
  "thread:provider:opencode:provider-instance:opencode_2:native-thread:ses_e57c66044ffeJccohiqo0CVEWO";
const PROVIDER_CODEX =
  "thread:provider:codex:native-thread:01a1a77d-831c-7c72-9032-bc61e00c205c";

describe("T3 thread identity validation (write policy)", () => {
  it("accepts the observed bounded mcp UUID form", () => {
    expect(isValidT3ThreadId(LEGACY)).toBe(true);
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

  it.each([
    ["bare UUID", BARE_UUID],
    ["launch command id", LAUNCH],
    ["delegated task id", DELEGATED],
    ["provider instance id", PROVIDER_INSTANCE],
    ["provider native id", PROVIDER_CODEX],
  ])("does NOT widen the write policy to the native %s", (_label, value) => {
    // Reads accept these; writes must not. Widening the write guard would let
    // link/unlink/launch/send/interrupt target threads Helm never created.
    expect(isValidT3ThreadId(value)).toBe(false);
    expect(isValidT3ThreadIdRead(value)).toBe(true);
  });
});

describe("T3 thread identity validation (read policy)", () => {
  it.each([
    ["legacy mcp UUID", LEGACY],
    ["bare UUID", BARE_UUID],
    ["launch command id", LAUNCH],
    ["delegated task id", DELEGATED],
    ["delegated task id with a slug", DELEGATED_SLUG],
    ["provider instance id", PROVIDER_INSTANCE],
    ["provider native id", PROVIDER_CODEX],
  ])("accepts the live-verified native %s", (_label, value) => {
    expect(isValidT3ThreadIdRead(value)).toBe(true);
  });

  it("keeps the legacy mcp form within the write length bound", () => {
    expect(LEGACY.length).toBe(MAX_T3_THREAD_ID_LENGTH);
  });

  it.each([
    ["empty", ""],
    ["whitespace", " "],
    ["leading whitespace", ` ${BARE_UUID}`],
    ["trailing whitespace", `${BARE_UUID} `],
    ["line break", "mcp:launch:\n" + "a".repeat(62)],
    ["NUL", "mcp:launch:\u0000" + "a".repeat(63)],
    ["arbitrary prefix", "thread:whatever"],
    ["unknown thread family", "thread:delegated-task:other"],
    ["uuid-like but not canonical", "5e476b4f-047e-4d72-bbfc-15d9498d31e"],
    ["launch with 63 hex", `mcp:launch:${"a".repeat(63)}`],
    ["launch with uppercase hex", `mcp:launch:${"A".repeat(64)}`],
    ["launch with extra segment", `${LAUNCH}:extra`],
    ["delegated with encoded newline", DELEGATED.replace("%3Adelegate-task%3A", "%3Adelegate-task%3Aabc%0Adef")],
    ["delegated with an extra segment", `${DELEGATED}%3Aextra`],
    ["delegated with a lowercase escape", DELEGATED.replaceAll("%3A", "%3a")],
    ["uppercase structural prefix", DELEGATED.replace("thread:", "THREAD:")],
    ["delegated without the command prefix", "thread:delegated-task:command%3Aother%3A" + "a".repeat(36)],
    ["provider with a colon in the native id", "thread:provider:codex:native-thread:abc:def"],
    ["provider without a native id", "thread:provider:codex:native-thread:"],
    ["very long provider id", `thread:provider:codex:native-thread:${"a".repeat(300)}`],
    ["over the read bound", `thread:provider:codex:native-thread:${"a".repeat(MAX_T3_THREAD_ID_READ_LENGTH)}`],
    ["null", null],
    ["number", 3],
  ])("rejects a malformed identifier (%s)", (_label, value) => {
    expect(isValidT3ThreadIdRead(value)).toBe(false);
  });

  it.each([
    ["legacy", "mcp:abcdef12-3456-4abc-8def-123456789012"],
    ["bare", "abcdef12-3456-4abc-8def-123456789012"],
    ["provider", "thread:provider:abcdef:native-thread:xyz"],
  ])("rejects a %s identifier containing the configured secret", (_label, value) => {
    expect(isValidT3ThreadIdRead(value, "abcdef")).toBe(false);
  });

  it("rejects percent-encoded control characters instead of decoding them", () => {
    // `%0A` must stay four literal characters and fail the allowlist, not
    // become a newline accepted by a looser pattern.
    expect(isValidT3ThreadIdRead("thread:provider:codex:native-thread:abc%0Adef")).toBe(false);
    expect(isValidT3ThreadIdRead("thread:provider:codex:native-thread:abc%00def")).toBe(false);
  });
});
