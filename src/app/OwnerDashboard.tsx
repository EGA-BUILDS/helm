"use client";

import { SignIn, SignOutButton, UserButton, useUser } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { Component, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { ConvexHealthStatus } from "./ConvexHealthStatus";

/**
 * Catches the fail-closed `unauthorized` error a signed-in non-owner gets
 * from the owner-gated session query, and renders the not-owner view instead
 * of crashing. Convex `useQuery` throws query errors during render, so the
 * boundary must sit above the component that subscribes.
 */
class OwnerErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const denied = this.state.error.message.toLowerCase().includes("unauthorized");
      return (
        <section className="w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">Private workspace</p>
          <h2 className="mt-3 text-2xl font-semibold">{denied ? "Not the Helm owner" : "Access could not be verified"}</h2>
          <p className="mt-2 text-slate-600">
            {denied
              ? "This account is signed in, but it is not authorized for this private workspace."
              : "Helm could not check private access. Retry when the connection is available."}
          </p>
          <div className="mt-6">
            <button onClick={this.props.onRetry} className="mr-3 rounded-lg border px-3 py-2 text-sm">{denied ? "Check access again" : "Retry"}</button>
            <SignOutButton><button className="rounded-lg border px-3 py-2 text-sm">Sign out</button></SignOutButton>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

/**
 * The Convex-verified owner view. Subscribes to the owner-gated `auth:session`
 * query, which throws for anyone but the configured owner; while the
 * subscription loads, no private data renders.
 */
function OwnerVerified() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const session = useQuery(api.auth.session, isAuthenticated ? {} : "skip");

  if (isLoading || session === undefined) {
    return <p role="status">Verifying owner access…</p>;
  }

  return (
    <section className="w-full max-w-3xl rounded-2xl border bg-white p-8 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">Private owner dashboard</p>
          <h2 className="mt-2 text-2xl font-semibold">Welcome to Helm</h2>
        </div>
        <div className="flex items-center gap-3">
          <UserButton />
          <SignOutButton><button className="rounded-lg border px-3 py-2 text-sm">Sign out</button></SignOutButton>
        </div>
      </div>
      <p className="mt-6 text-slate-600">Owner access verified by Convex.</p>
      <p className="mt-2 text-sm text-slate-500">No project data or execution controls are enabled in this login foundation.</p>
      <div className="mt-4"><ConvexHealthStatus /></div>
    </section>
  );
}

export function OwnerDashboard() {
  const [retryVersion, setRetryVersion] = useState(0);
  const { isLoaded, isSignedIn } = useUser();
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (!isLoaded) {
    return <p role="status">Checking your private Helm session…</p>;
  }

  if (!isSignedIn) {
    return (
      <section className="w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">Private workspace</p>
        <h2 className="mt-3 text-2xl font-semibold">Sign in to Helm</h2>
        <p className="mt-2 text-slate-600">Helm is available to its approved owner.</p>
        <div className="mt-6"><SignIn routing="hash" signUpUrl="" appearance={{ elements: { footerActionLink: { display: "none" } } }} /></div>
      </section>
    );
  }

  if (isLoading) {
    return <p role="status">Connecting your secure Helm session…</p>;
  }

  if (!isAuthenticated) {
    return (
      <section className="w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        <h2 className="text-2xl font-semibold">Session not verified</h2>
        <p className="mt-2 text-slate-600">Helm could not verify this session with its private backend.</p>
        <div className="mt-6"><SignOutButton><button className="rounded-lg border px-3 py-2 text-sm">Sign out</button></SignOutButton></div>
      </section>
    );
  }

  return (
    <OwnerErrorBoundary key={retryVersion} onRetry={() => setRetryVersion((version) => version + 1)}>
      <OwnerVerified />
    </OwnerErrorBoundary>
  );
}
