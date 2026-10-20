"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createLinearIssuesAdapter,
  toIssueError,
  type IssueError,
  type IssuesPage,
  type LinearIssue,
} from "../linear/issues";
import {
  createLinearMappingsAdapter,
  toMappingError,
  type MappingError,
  type ProjectMapping,
} from "../linear/mappings";
import {
  createManualLinkAdapter,
  toManualLinkError,
  type ManualLinkAdapter,
  type ManualLinkAssociation,
  type ManualLinkError,
} from "./manualLink";

export interface ManualLinkControlProps {
  connectionId: string;
  projectId: string;
  threadId: string;
  threadTitle?: string | null;
  /** Optional pre-read association so a server render / reload is never empty. */
  initialAssociation?: ManualLinkAssociation | null;
  adapter?: ManualLinkAdapter;
  issuesAdapter?: ReturnType<typeof createLinearIssuesAdapter>;
  mappingsAdapter?: ReturnType<typeof createLinearMappingsAdapter>;
  onLinked?: (result: { associationId: string; created: boolean }) => void;
  onUnlinked?: (result: { removed: boolean; deleted: boolean; unlinked: boolean; associationId: string | null }) => void;
  onReassigned?: (result: { associationId: string; created: boolean }) => void;
}

const buttonClass = "rounded-lg border px-3 py-2 text-sm";
const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";

function provenanceLabel(value: ManualLinkAssociation): string {
  return value.provenance === "manual" ? "manual link (no launch evidence)" : "launch-derived binding";
}

export function ManualLinkControl({
  connectionId,
  projectId,
  threadId,
  threadTitle,
  initialAssociation = null,
  adapter,
  issuesAdapter,
  mappingsAdapter,
  onLinked,
  onUnlinked,
  onReassigned,
}: ManualLinkControlProps) {
  const resolvedAdapter = useMemo(() => adapter ?? createManualLinkAdapter(), [adapter]);
  const resolvedIssuesAdapter = useMemo(() => issuesAdapter ?? createLinearIssuesAdapter(), [issuesAdapter]);
  const resolvedMappingsAdapter = useMemo(() => mappingsAdapter ?? createLinearMappingsAdapter(), [mappingsAdapter]);

  const identityKey = `${connectionId}\u0000${projectId}\u0000${threadId}`;
  const identityRef = useRef(identityKey);
  useEffect(() => {
    identityRef.current = identityKey;
  }, [identityKey]);

  // Current association (re-read on mount and after every mutation).
  const [association, setAssociation] = useState<ManualLinkAssociation | null>(initialAssociation);
  const [associationLoading, setAssociationLoading] = useState<boolean>(initialAssociation === undefined);
  const [associationError, setAssociationError] = useState<ManualLinkError | null>(null);

  // Issue browsing.
  const [mappings, setMappings] = useState<ProjectMapping[] | null>(null);
  const [mappingsError, setMappingsError] = useState<MappingError | null>(null);
  const [selectedMappingKey, setSelectedMappingKey] = useState<string>("");
  const [issuesPage, setIssuesPage] = useState<IssuesPage | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<IssueError | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string>("");

  // Mutation state.
  const [linkBusy, setLinkBusy] = useState(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [reassignBusy, setReassignBusy] = useState(false);
  const [linkError, setLinkError] = useState<ManualLinkError | null>(null);
  const [unlinkError, setUnlinkError] = useState<ManualLinkError | null>(null);
  const [reassignError, setReassignError] = useState<ManualLinkError | null>(null);
  const [linkResult, setLinkResult] = useState<{ associationId: string; created: boolean } | null>(null);
  const [unlinkResult, setUnlinkResult] = useState<{ removed: boolean; deleted: boolean; unlinked: boolean; associationId: string | null } | null>(null);
  const [reassignResult, setReassignResult] = useState<{ associationId: string; created: boolean } | null>(null);

  // Confirmation gates.
  const [unlinkArmed, setUnlinkArmed] = useState(false);
  const [reassignArmed, setReassignArmed] = useState(false);
  const [confirmLaunchEvidenceLoss, setConfirmLaunchEvidenceLoss] = useState(false);

  const selectedMapping = useMemo(
    () => (mappings ?? []).find((m) => `${m.linearProjectId}:${m.linearTeamId}` === selectedMappingKey) ?? null,
    [mappings, selectedMappingKey],
  );
  const selectedIssue = useMemo(
    () => issuesPage?.items.find((issue) => issue.id === selectedIssueId) ?? null,
    [issuesPage, selectedIssueId],
  );

  // Reset perishable state on identity change.
  const [seen, setSeen] = useState(identityKey);
  if (seen !== identityKey) {
    setSeen(identityKey);
    setAssociation(initialAssociation);
    setAssociationLoading(initialAssociation === undefined);
    setAssociationError(null);
    setMappings(null);
    setMappingsError(null);
    setSelectedMappingKey("");
    setIssuesPage(null);
    setIssuesLoading(false);
    setIssuesError(null);
    setSelectedIssueId("");
    setLinkBusy(false);
    setUnlinkBusy(false);
    setReassignBusy(false);
    setLinkError(null);
    setUnlinkError(null);
    setReassignError(null);
    setLinkResult(null);
    setUnlinkResult(null);
    setReassignResult(null);
    setUnlinkArmed(false);
    setReassignArmed(false);
    setConfirmLaunchEvidenceLoss(false);
  }

  // Read current association on mount / identity change.
  useEffect(() => {
    if (!connectionId || !projectId || !threadId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      setAssociationLoading(true);
      setAssociationError(null);
    });
    resolvedAdapter
      .readAssociation({ connectionId, projectId, threadId }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setAssociation(value);
        setAssociationLoading(false);
      })
      .catch((thrown) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setAssociationError(toManualLinkError(thrown));
        setAssociationLoading(false);
      });
    return () => controller.abort();
  }, [identityKey, connectionId, projectId, threadId, resolvedAdapter]);

  // Load mappings.
  useEffect(() => {
    const controller = new AbortController();
    resolvedMappingsAdapter
      .listMappings(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setMappings(rows);
        const enabled = rows.filter((row) => row.enabled);
        const matching =
          enabled.find((row) => String(row.t3ConnectionId) === connectionId && row.t3ProjectId === projectId) ??
          enabled.find((row) => String(row.t3ConnectionId) === connectionId) ??
          enabled[0] ??
          null;
        if (matching) setSelectedMappingKey(`${matching.linearProjectId}:${matching.linearTeamId}`);
      })
      .catch((thrown) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setMappingsError(toMappingError(thrown));
      });
    return () => controller.abort();
  }, [identityKey, connectionId, projectId, resolvedMappingsAdapter]);

  // Load issues for selected mapping.
  useEffect(() => {
    if (!selectedMapping) {
      queueMicrotask(() => setIssuesPage(null));
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      setIssuesLoading(true);
      setIssuesError(null);
      setSelectedIssueId("");
    });
    resolvedIssuesAdapter
      .browseIssues({ projectId: selectedMapping.linearProjectId, limit: 25 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setIssuesPage(page);
        setIssuesLoading(false);
      })
      .catch((thrown) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        setIssuesError(toIssueError(thrown));
        setIssuesLoading(false);
      });
    return () => controller.abort();
  }, [identityKey, selectedMapping, resolvedIssuesAdapter]);

  const hasLaunchEvidence = association !== null && association.attemptId !== "";

  async function handleLink() {
    if (!selectedMapping || !selectedIssue || linkBusy) return;
    setLinkBusy(true);
    setLinkError(null);
    setLinkResult(null);
    try {
      const result = await resolvedAdapter.link({
        connectionId,
        projectId,
        threadId,
        linearWorkspaceId: selectedMapping.linearWorkspaceId,
        linearProjectId: selectedMapping.linearProjectId,
        linearTeamId: selectedMapping.linearTeamId,
        linearIssueId: selectedIssue.id,
        linearIssueIdentifier: selectedIssue.identifier,
        confirm: false,
      });
      setLinkResult(result);
      // Re-read association.
      const next = await resolvedAdapter.readAssociation({ connectionId, projectId, threadId });
      setAssociation(next);
      onLinked?.(result);
    } catch (thrown) {
      setLinkError(toManualLinkError(thrown));
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleUnlink() {
    if (!association || !unlinkArmed || unlinkBusy) return;
    setUnlinkBusy(true);
    setUnlinkError(null);
    setUnlinkResult(null);
    try {
      const result = await resolvedAdapter.unlink({
        connectionId,
        projectId,
        threadId,
        confirm: true,
        expectedAssociationId: association.associationId,
      });
      setUnlinkResult(result);
      setUnlinkArmed(false);
      const next = await resolvedAdapter.readAssociation({ connectionId, projectId, threadId });
      setAssociation(next);
      onUnlinked?.(result);
    } catch (thrown) {
      setUnlinkError(toManualLinkError(thrown));
    } finally {
      setUnlinkBusy(false);
    }
  }

  async function handleReassign() {
    if (!association || !selectedMapping || !selectedIssue || !reassignArmed || reassignBusy) return;
    if (hasLaunchEvidence && !confirmLaunchEvidenceLoss) return;
    setReassignBusy(true);
    setReassignError(null);
    setReassignResult(null);
    try {
      const result = await resolvedAdapter.reassign({
        connectionId,
        projectId,
        threadId,
        linearWorkspaceId: selectedMapping.linearWorkspaceId,
        linearProjectId: selectedMapping.linearProjectId,
        linearTeamId: selectedMapping.linearTeamId,
        linearIssueId: selectedIssue.id,
        linearIssueIdentifier: selectedIssue.identifier,
        confirm: true,
        confirmLaunchEvidenceLoss: hasLaunchEvidence ? confirmLaunchEvidenceLoss : undefined,
        expectedAssociationId: association.associationId,
      });
      setReassignResult(result);
      setReassignArmed(false);
      const next = await resolvedAdapter.readAssociation({ connectionId, projectId, threadId });
      setAssociation(next);
      onReassigned?.(result);
    } catch (thrown) {
      const err = toManualLinkError(thrown);
      setReassignError(err);
      // Re-read to refresh the concurrency token; never retry blindly.
      try {
        const next = await resolvedAdapter.readAssociation({ connectionId, projectId, threadId });
        setAssociation(next);
      } catch {
        // ignore
      }
    } finally {
      setReassignBusy(false);
    }
  }

  const isReassignment =
    association !== null && selectedIssue !== null && association.linearIssueId !== selectedIssue.id;

  return (
    <section aria-label="Manual thread issue link">
      <h3>Manual Linear issue link</h3>
      <p>
        Thread {threadTitle ? `"${threadTitle}" ` : ""}({threadId}) in project {projectId} via connection {connectionId}.
      </p>
      <p className="text-xs text-slate-500">
        Linking creates a binding only. It does not change the Linear issue state, does not launch or message the thread,
        and does not touch Git.
      </p>

      <h4>Current association</h4>
      {associationLoading && <p role="status">Reading the current association…</p>}
      {associationError && <p role="alert">Could not read the current association: {associationError.message}</p>}
      {!associationLoading && !associationError && association === null && (
        <p>No Linear issue is currently linked to this thread.</p>
      )}
      {association !== null && (
        <div>
          <p>
            Linked to {association.linearIssueIdentifier} ({association.linearIssueId}) — {provenanceLabel(association)}.
          </p>
          <p className="text-xs text-slate-500">
            Association {association.associationId} · created {new Date(association.createdAt).toISOString()} · state{" "}
            {association.ledgerState ?? "linked"}.
          </p>
          {hasLaunchEvidence && (
            <p className="text-xs text-amber-700">
              This binding carries launch evidence; reassigning it requires explicit confirmation of launch-evidence loss.
            </p>
          )}
          {unlinkArmed ? (
            <div>
              <p>Confirm unlinking this thread from {association.linearIssueIdentifier}? This removes the binding only.</p>
              <button type="button" className={buttonClass} onClick={() => void handleUnlink()} disabled={unlinkBusy}>
                {unlinkBusy ? "Unlinking…" : "Confirm unlink"}
              </button>{" "}
              <button type="button" className={buttonClass} onClick={() => setUnlinkArmed(false)} disabled={unlinkBusy}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className={buttonClass} onClick={() => setUnlinkArmed(true)} disabled={unlinkBusy}>
              Unlink thread
            </button>
          )}
          {unlinkError && <p role="alert">{unlinkError.message}</p>}
        </div>
      )}

      <h4>Link or reassign to a Linear issue</h4>
      {mappingsError && <p role="alert">{mappingsError.message}</p>}
      {mappings === null && !mappingsError && <p role="status">Loading mapped projects…</p>}
      {mappings !== null && (
        <label className="block text-sm">
          Mapped project
          <select
            className={inputClass}
            value={selectedMappingKey}
            onChange={(event) => setSelectedMappingKey(event.target.value)}
          >
            <option value="">Select a mapped project…</option>
            {(mappings ?? [])
              .filter((m) => m.enabled)
              .map((m) => (
                <option key={`${m.linearProjectId}:${m.linearTeamId}`} value={`${m.linearProjectId}:${m.linearTeamId}`}>
                  {m.linearProjectName} · {m.linearTeamKey}
                </option>
              ))}
          </select>
        </label>
      )}

      {issuesLoading && <p role="status">Reading Linear issues…</p>}
      {issuesError && <p role="alert">{issuesError.message}</p>}
      {issuesPage !== null && issuesPage.items.length === 0 && !issuesLoading && !issuesError && (
        <p>No issues match this project.</p>
      )}
      {issuesPage !== null && issuesPage.items.length > 0 && (
        <ul className="mt-2 space-y-2">
          {issuesPage.items.map((issue: LinearIssue) => (
            <li key={issue.id} className="rounded border p-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`manual-link-issue-${identityKey}`}
                  checked={selectedIssueId === issue.id}
                  onChange={() => setSelectedIssueId(issue.id)}
                />
                <span>
                  {issue.identifier} — {issue.title}
                  <span className="block text-xs text-slate-500">
                    {issue.state.name} · {issue.team.key}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {selectedIssue && (
        <p className="mt-2 text-sm">
          Selected: {selectedIssue.identifier} — {selectedIssue.title}
        </p>
      )}

      {!association && (
        <div className="mt-3">
          <button
            type="button"
            className={buttonClass}
            onClick={() => void handleLink()}
            disabled={!selectedIssue || linkBusy}
          >
            {linkBusy ? "Linking…" : "Link thread to issue"}
          </button>
          {linkError && <p role="alert">{linkError.message}</p>}
        </div>
      )}

      {linkResult && (
        <p role="status">
          Linked (created {String(linkResult.created)}). The Linear issue state was not changed.
        </p>
      )}
      {unlinkResult && (
        <p role="status">
          Unlinked (removed {String(unlinkResult.removed)}). The Linear issue state was not changed.
        </p>
      )}

      {association !== null && (
        <div className="mt-3">
          {hasLaunchEvidence && (
            <label className="block text-sm">
              <input
                type="checkbox"
                checked={confirmLaunchEvidenceLoss}
                onChange={(event) => setConfirmLaunchEvidenceLoss(event.target.checked)}
              />
              {" "}I understand this reassignment discards launch evidence for this thread.
            </label>
          )}
          {reassignArmed && selectedIssue && isReassignment ? (
            <div>
              <p>
                Confirm reassigning this thread from {association.linearIssueIdentifier} to{" "}
                {selectedIssue.identifier}? This requires the current association token.
              </p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => void handleReassign()}
                disabled={reassignBusy || (hasLaunchEvidence && !confirmLaunchEvidenceLoss)}
              >
                {reassignBusy ? "Reassigning…" : "Confirm reassignment"}
              </button>{" "}
              <button
                type="button"
                className={buttonClass}
                onClick={() => setReassignArmed(false)}
                disabled={reassignBusy}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={buttonClass}
              onClick={() => setReassignArmed(true)}
              disabled={reassignBusy || !selectedIssue}
            >
              Reassign to selected issue
            </button>
          )}
          {reassignError && <p role="alert">{reassignError.message}</p>}
          {reassignResult && (
            <p role="status">
              Reassigned (created {String(reassignResult.created)}). The Linear issue state was not changed.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
