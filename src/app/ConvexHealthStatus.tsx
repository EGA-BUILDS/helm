"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * The configured subtree: it only renders inside `ConvexClientProvider` with
 * `NEXT_PUBLIC_CONVEX_URL` set, so `useQuery` always runs within a
 * `ConvexProvider`.
 */
export function ConvexHealthStatus() {
  const health = useQuery(api.health.check, {});

  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-lg border px-4 py-3"
    >
      {health?.status === "ok" ? "Convex connected" : "Connecting to Convex…"}
    </p>
  );
}
