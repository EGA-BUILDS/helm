"use client";

import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";
import { Suspense, useState, type ReactNode } from "react";
import { ConvexSetupRequired } from "./ConvexSetupRequired";

/**
 * Accessible loading state for the boundary that wraps the provider.
 */
function ProviderFallback() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-lg border px-4 py-3"
    >
      Connecting to Convex…
    </p>
  );
}

/**
 * Owns the single Convex client for the subtree it wraps.
 *
 * `new ConvexReactClient(url)` reads `Math.random()` to mint its session id, so
 * it must never run while Next.js prerenders the static shell. The
 * `<Suspense>` boundary below therefore sits above this component — it
 * surrounds provider initialization itself, not just the page beneath it. The
 * client is created once through `useState` and reused for the lifetime of the
 * provider, never on every render.
 */
function ConvexClient({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  const [client] = useState(() => new ConvexReactClient(url));
  return (
    <ConvexProviderWithClerk client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}

/**
 * Branches on configuration only:
 *
 * - `NEXT_PUBLIC_CONVEX_URL` set: the configured subtree renders inside
 *   `ConvexProviderWithClerk`, so authenticated requests carry Clerk tokens
 *   above it.
 * - unset: a self-contained "Configuration required" state renders instead, so
 *   nothing calls a Convex hook outside a provider and nothing crashes.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  if (!convexUrl) {
    return <ConvexSetupRequired />;
  }

  return (
    <Suspense fallback={<ProviderFallback />}>
      <ConvexClient url={convexUrl}>{children}</ConvexClient>
    </Suspense>
  );
}
