/** Shared, side-effect-free URL policy for isolated dispatch and setup reports. */
export function isValidIsolatedEndpoint(value: string): boolean {
  if (!value || value !== value.trim() || !value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
