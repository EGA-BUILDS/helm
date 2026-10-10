import { ConvexClientProvider } from "./ConvexClientProvider";
import { OwnerDashboard } from "./OwnerDashboard";

/**
 * The provider is placed here, around only the Convex-using subtree, so the
 * static shell keeps the Helm heading while the provider initializes behind its
 * `<Suspense>` boundary. The root layout stays a Server Component.
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-semibold">Helm</h1>
      <ConvexClientProvider>
        <OwnerDashboard />
      </ConvexClientProvider>
    </main>
  );
}
