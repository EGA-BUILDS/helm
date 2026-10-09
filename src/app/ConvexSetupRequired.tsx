/**
 * Setup state shown when `NEXT_PUBLIC_CONVEX_URL` is not configured.
 *
 * It deliberately calls no Convex hooks: it renders in place of (not around)
 * the configured subtree, so nothing runs outside its provider, nothing throws,
 * and the UI never claims a connection that does not exist.
 */
export function ConvexSetupRequired() {
  return (
    <div
      role="alert"
      className="flex max-w-md flex-col gap-2 rounded-lg border border-amber-600 px-4 py-3 text-left"
    >
      <p className="font-semibold">Configuration required</p>
      <p>
        <code className="font-mono text-sm">NEXT_PUBLIC_CONVEX_URL</code> is not
        set, so Helm has no Convex backend to connect to yet.
      </p>
      <p>
        Add your deployment URL to <code>.env.local</code> and restart the app.
      </p>
    </div>
  );
}
