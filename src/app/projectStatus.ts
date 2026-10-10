export type DisplayConnectionStatus = "configured" | "connected" | "disconnected" | "stale" | "blocked";

export function displayConnectionStatus(input: {
  configured: boolean;
  status?: "connected" | "disconnected" | "blocked";
  lastCheckAt?: number;
  now: number;
  maxAgeMs: number;
}): DisplayConnectionStatus {
  if (!input.configured) return "blocked";
  if (!input.status) return "configured";
  if (input.status === "connected" && input.lastCheckAt !== undefined && input.now - input.lastCheckAt > input.maxAgeMs) return "stale";
  return input.status;
}
