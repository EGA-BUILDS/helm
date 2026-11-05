import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { AttentionBadge } from "./AttentionBadge";
import type { AttentionResult, InterruptAdapter } from "./interrupt";

/**
 * Browser-spec harness for the attention badge's stale-response rule.
 *
 * The adapter's `attention` call never settles on its own: the spec decides
 * exactly when each thread's response resolves. That makes the race
 * deterministic — select thread B, then resolve thread A late — without
 * timers or live T3 calls.
 */

export interface AttentionHarnessControl {
  select(threadId: string): void;
  pending(): string[];
  resolve(threadId: string, result: AttentionResult): void;
}

export function mountAttentionHarness(container: HTMLElement, initialThreadId: string): AttentionHarnessControl {
  const pending: { threadId: string; resolve: (result: AttentionResult) => void }[] = [];

  const adapter: InterruptAdapter = {
    interrupt: async () => {
      throw new Error("interrupt is not exercised by this harness");
    },
    attention: (input) =>
      new Promise<AttentionResult>((resolve) => {
        pending.push({ threadId: input.threadId, resolve });
      }),
  };

  const control: AttentionHarnessControl = {
    select: () => undefined,
    pending: () => pending.map((entry) => entry.threadId),
    resolve: (threadId, result) => {
      const index = pending.findIndex((entry) => entry.threadId === threadId);
      if (index === -1) throw new Error(`no pending attention read for ${threadId}`);
      const [entry] = pending.splice(index, 1);
      entry.resolve(result);
    },
  };

  function Harness() {
    const [threadId, setThreadId] = useState(initialThreadId);
    control.select = setThreadId;
    return createElement(AttentionBadge, {
      connectionId: "c-1",
      projectId: "t3-proj-1",
      threadId,
      adapter,
    });
  }

  (window as unknown as { __attentionHarness: AttentionHarnessControl }).__attentionHarness = control;
  createRoot(container).render(createElement(Harness));
  return control;
}
