/**
 * T3's published tool schema only says `string`; it does not document the full
 * identifier grammar. Prior authorized integration captures consistently show
 * `mcp:<UUID>`. Accept only that observed form until T3 publishes a complete
 * contract. Any new provider form stays unresolved instead of being trusted.
 */
export const MAX_T3_THREAD_ID_LENGTH = 40;
const OBSERVED_T3_THREAD_ID = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
