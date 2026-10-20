"use client";

/**
 * Verified pull-request panel for one selected native T3 thread (EGA-766).
 *
 * Integration-owned: the verification core and the card belong to the EGA-766
 * lane; this is the fetch + mount that the lead owns, because `Dashboard.tsx`
 * is a shared file no feature lane may edit.
 *
 * Three rules this component must not break:
 *
 *  1. **Never show a state before it is known.** `null` means "not read yet" to
 *     the card, which would render as "No pull request" — a claim we have not
 *     earned. So while a read is in flight, or after a failure, this panel
 *     says so in its own words instead of passing `null` down.
 *  2. **A late response must not describe a different thread.** The settled
 *     result is stored with the identity that produced it, so a response for a
 *     previous selection can never be rendered against the new one.
 *  3. **No request in a fixture preview.** The caller only mounts this for a
 *     live controller, and the fetch is skipped when the identity is missing.
 */

import { useEffect, useMemo, useState } from "react";
import { VerifiedPullRequestCard } from "./VerifiedPullRequestCard";
import { presentPullRequest } from "./verifiedPullRequest";
import type { PullRequestVerification } from "../../../convex/lib/verifiedPullRequest";

export interface VerifiedPullRequestPanelProps {
  connectionId: string;
  threadId: string;
  /** Override for tests; defaults to the same-origin HTTP read. */
  fetchImpl?: FetchLike;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Stable module-level default so the effect dependency never churns. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

type Load =
  | { kind: "ready"; verification: PullRequestVerification }
  | { kind: "failed"; message: string };

function messageFor(status: number): string {
  if (status === 401) return "Sign in as the Helm owner to check pull requests.";
  if (status === 400) return "Select a T3 thread to check its pull request.";
  return "The pull-request check is unavailable right now. Nothing is assumed about it.";
}

export function VerifiedPullRequestPanel({ connectionId, threadId, fetchImpl }: VerifiedPullRequestPanelProps) {
  const identity = useMemo(() => `${connectionId}\u0000${threadId}`, [connectionId, threadId]);
  const [settled, setSettled] = useState<{ identity: string; load: Load } | null>(null);
  const doFetch = fetchImpl ?? defaultFetch;

  useEffect(() => {
    if (!connectionId || !threadId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ connectionId, threadId }).toString();
    doFetch(`/api/t3/threads/pull-request?${query}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setSettled({ identity, load: { kind: "failed", message: messageFor(response.status) } });
          return;
        }
        const body = (await response.json()) as PullRequestVerification;
        if (controller.signal.aborted) return;
        setSettled({ identity, load: { kind: "ready", verification: body } });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSettled({
          identity,
          load: { kind: "failed", message: "The pull-request check could not be reached. Nothing is assumed about it." },
        });
      });
    return () => controller.abort();
  }, [identity, connectionId, threadId, doFetch]);

  if (!connectionId || !threadId) return null;

  // Derived, not stored: a settled load for a different identity reads as
  // "still reading", so a stale receipt is never attributed to this thread.
  const load: Load | null = settled && settled.identity === identity ? settled.load : null;

  if (load === null) {
    return (
      <section aria-label="Pull request">
        <h4>Pull request</h4>
        <p className="help" role="status">Checking the pull request with GitHub…</p>
      </section>
    );
  }

  if (load.kind === "failed") {
    return (
      <section aria-label="Pull request">
        <h4>Pull request</h4>
        <p className="help" role="status">{load.message}</p>
      </section>
    );
  }

  const presentation = presentPullRequest(load.verification);
  return (
    <section aria-label="Pull request">
      <VerifiedPullRequestCard verification={load.verification} heading="Pull request" />
      {presentation.kind === "verified" && presentation.state ? (
        <p className="help">
          Verified against the branch T3 reports for this thread. A verified pull request is not an approval and not a merge.
        </p>
      ) : null}
    </section>
  );
}
