"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function Home() {
  const health = useQuery(api.health.check, {});

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-semibold">Helm</h1>
      <p>Your software execution hub.</p>
      <p role="status" className="rounded-lg border px-4 py-3">
        {health?.status === "ok"
          ? "Convex connected"
          : "Connecting to Convex…"}
      </p>
    </main>
  );
}
