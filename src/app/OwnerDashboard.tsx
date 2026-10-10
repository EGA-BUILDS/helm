"use client";

import { SignIn, SignOutButton, UserButton, useUser } from "@clerk/nextjs";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { ConvexHealthStatus } from "./ConvexHealthStatus";
import { displayConnectionStatus } from "./projectStatus";

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
  const overview = useQuery(api.projects.getOverview, isAuthenticated ? {} : "skip");
  const checkConnection = useAction(api.connections.check);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, [overview]);

  if (isLoading || session === undefined) {
    return <p role="status">Verifying owner access…</p>;
  }

  const check = async (kind: "linear" | "t3") => {
    setChecking(kind);
    setCheckError(null);
    try {
      await checkConnection({ kind });
    } catch {
      setCheckError("The connection check could not be completed. Access or service configuration may have changed.");
    } finally {
      setChecking(null);
    }
  };
  const connectionCard = (kind: "linear" | "t3", title: string) => {
    const connection = overview?.connections.find((item) => item.kind === kind);
    const status = displayConnectionStatus({
      configured: Boolean(overview?.project),
      status: connection?.status,
      lastCheckAt: connection?.lastCheckAt,
      now,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    return (
      <div className="rounded-xl border border-slate-200 p-4" key={kind}>
        <div className="flex items-center justify-between gap-3">
          <div><h4 className="font-medium">{title}</h4><p className="mt-1 text-sm capitalize text-slate-600">{status}</p></div>
          <button disabled={checking !== null} onClick={() => void check(kind)} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">
            {checking === kind ? "Checking…" : "Check connection"}
          </button>
        </div>
        {connection && <div className="mt-3 text-sm text-slate-600">
          <p>Last check: {new Date(connection.lastCheckAt).toLocaleString()}</p>
          <p>Last successful check: {connection.lastSuccessAt ? new Date(connection.lastSuccessAt).toLocaleString() : "Never"}</p>
          {connection.errorCategory && <p className="mt-2 text-amber-800">{connection.errorCategory}: {connection.guidance}</p>}
          {connection.catalogObservedAt && <p>Capability catalog observed: {new Date(connection.catalogObservedAt).toLocaleString()}</p>}
          {connection.capabilities.length > 0 && <p>Verified capabilities: {connection.capabilities.join(", ")}</p>}
        </div>}
      </div>
    );
  };

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
      <div className="mt-6 border-t border-slate-200 pt-5">
        <h3 className="text-lg font-semibold">Project and connected services</h3>
        {!overview ? <p role="status" className="mt-3 text-sm text-slate-500">Loading trusted project configuration…</p> : !overview.project ? (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Blocked: no valid trusted project mapping is configured on the server.</p>
        ) : <>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">Repository</dt><dd>{overview.project.repository}</dd></div>
            <div><dt className="text-slate-500">Linear project</dt><dd>{overview.project.linearProjectId}</dd></div>
            <div><dt className="text-slate-500">T3 environment</dt><dd>{overview.project.t3EnvironmentId}</dd></div>
            <div><dt className="text-slate-500">T3 project</dt><dd>{overview.project.t3ProjectId}</dd></div>
            <div><dt className="text-slate-500">Base reference</dt><dd>{overview.project.baseRef}</dd></div>
          </dl>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">{connectionCard("linear", "Linear")}{connectionCard("t3", "Isolated T3")}</div>
        </>}
        {checkError && <p role="alert" className="mt-3 text-sm text-red-700">{checkError}</p>}
        <p className="mt-4 text-xs text-slate-500">Connection checks read service identity only. Credentials and upstream response bodies are never shown.</p>
      </div>
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
