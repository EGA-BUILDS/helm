import { ConvexClientProvider } from "./ConvexClientProvider";
import { OwnerDashboard } from "./OwnerDashboard";

/**
 * The provider is placed here, around only the Convex-using subtree, so the
 * static shell keeps the Helm heading while the provider initializes behind its
 * `<Suspense>` boundary. The root layout stays a Server Component.
 */
export default function Home() {
  return (
    <main className="min-h-screen w-full">
      <h1 className="sr-only">Helm</h1>
      <ConvexClientProvider>
        <OwnerDashboard />
      </ConvexClientProvider>
    </main>
  );
}
