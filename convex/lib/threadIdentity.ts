/**
 * T3's published tool schema only says `string`; it does not document the full
 * identifier grammar.
 *
 * Two policies, deliberately different:
 *
 *  - **Write paths** keep the conservative, original allowlist. Helm only
 *    writes against the form its own integration created (`mcp:<UUID>`), so
 *    accepting anything else would widen a mutation surface on the strength of
 *    an undocumented upstream format.
 *  - **Read paths** must be able to address the native threads T3 actually
 *    returns. Live `t3_thread_list` evidence over 100 threads (each confirmed
 *    by a successful `t3_thread_read` that echoed the same `threadId`) shows
 *    four native shapes in addition to the legacy form. Reads therefore use a
 *    separate, still anchored and bounded, allowlist.
 *
 * Neither policy decodes or encodes the identifier. The `%3A` sequences in a
 * delegated-task id are literal characters, not percent-encoding: transport
 * layers may URL-encode the value for a query string, but the policy always
 * sees the decoded-once, literal identifier.
 */

export const MAX_T3_THREAD_ID_LENGTH = 40;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_V4 = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

const OBSERVED_T3_THREAD_ID = new RegExp(`^mcp:${UUID_V4}$`, "i");

export function isValidT3ThreadId(value: unknown, configuredSecret?: string): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_T3_THREAD_ID_LENGTH ||
    !OBSERVED_T3_THREAD_ID.test(value)
  ) {
    return false;
  }
  return !configuredSecret || !value.includes(configuredSecret);
}

/**
 * Read-side bound. The longest observed shapes are well under this; the bound
 * exists so a caller cannot make Helm hold or forward an unbounded string.
 * Native shapes are additionally constrained by their own anchored patterns.
 */
export const MAX_T3_THREAD_ID_READ_LENGTH = 256;

/**
 * Live-verified native read shapes. Every entry is anchored and uses an
 * explicit charset; there is no prefix catch-all.
 *
 *  - bare UUID: T3 web-created threads.
 *  - `mcp:<UUID>`: the legacy integration form Helm already used.
 *  - `mcp:launch:<sha256 hex>`: the launched-thread command id.
 *  - `thread:delegated-task:command%3Amcp%3A<UUID>%3Adelegate-task%3A<slug>`:
 *    agent-delegated threads. `%3A` is literal.
 *  - `thread:provider:<provider>[:provider-instance:<instance>]:native-thread:<id>`:
 *    provider/subagent threads (for example Codex UUIDv7 ids and OpenCode
 *    `ses_…` ids).
 */
const NATIVE_T3_THREAD_ID_READ_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${UUID}$`),
  new RegExp(`^mcp:${UUID_V4}$`),
  new RegExp("^mcp:launch:[0-9a-f]{64}$"),
  new RegExp(
    `^thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3A[A-Za-z0-9._-]{1,64}$`,
  ),
  new RegExp(
    "^thread:provider:[A-Za-z0-9_-]{1,32}(?::provider-instance:[A-Za-z0-9_-]{1,64})?:native-thread:[A-Za-z0-9_-]{1,128}$",
  ),
];

export function isValidT3ThreadIdRead(value: unknown, configuredSecret?: string): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_T3_THREAD_ID_READ_LENGTH ||
    !NATIVE_T3_THREAD_ID_READ_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return false;
  }
  return !configuredSecret || !value.includes(configuredSecret);
}
