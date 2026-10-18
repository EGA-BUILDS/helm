"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createLinearMappingsAdapter,
  toMappingError,
  type MappingCandidates,
  type MappingError,
  type ProjectMapping,
} from "./mappings";

/**
 * Owner-facing Linear → T3 project mappings surface (EGA-760).
 *
 * Lists saved mappings and offers create/edit/disable. Every destination is
 * picked from live candidates — a Linear project plus one of its teams, and a
 * native T3 project — so a mapping can never fall back to the project root or
 * to an arbitrary destination. The per-team started state is resolved by the
 * backend and shown read-only; a team whose state is missing or ambiguous
 * blocks the save with the backend's specific reason.
 */

interface MappingsData {
  mappings: ProjectMapping[] | null;
  mappingsError: MappingError | null;
  candidates: MappingCandidates | null;
  candidatesError: MappingError | null;
}

function emptyData(): MappingsData {
  return { mappings: null, mappingsError: null, candidates: null, candidatesError: null };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const buttonClass = "rounded-lg border px-3 py-2 text-sm";

export function MappingsView({ data, notice, error, busy, onSave, onDisable }: {
  data: MappingsData;
  notice: string | null;
  error: MappingError | null;
  busy: string | null;
  onSave: (input: {
    mappingId?: string;
    linearProjectId: string;
    linearTeamId: string;
    t3ConnectionId: string;
    t3EnvironmentId: string;
    t3ProjectId: string;
    worktreeBaseRef: string;
    targetBranch: string;
  }) => void;
  onDisable: (mappingId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [linearProjectId, setLinearProjectId] = useState("");
  const [linearTeamId, setLinearTeamId] = useState("");
  const [t3ConnectionId, setT3ConnectionId] = useState("");
  const [t3ProjectId, setT3ProjectId] = useState("");
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [confirmingDisable, setConfirmingDisable] = useState<string | null>(null);

  const projects = data.candidates?.projects ?? [];
  const selectedProject = projects.find((project) => project.projectId === linearProjectId) ?? null;
  const selectedTeam = selectedProject?.teams.find((team) => team.teamId === linearTeamId) ?? null;
  const t3Connections = data.candidates?.t3.connections ?? [];
  const selectedConnection = t3Connections.find((connection) => connection.connectionId === t3ConnectionId) ?? null;
  const selectedT3Project = selectedConnection?.projects.find((project) => project.projectId === t3ProjectId) ?? null;
  const teamBlocked = selectedTeam !== null && (selectedTeam.startedStateId === null || selectedTeam.stateError !== null);

  function startEdit(mapping: ProjectMapping) {
    setEditingId(mapping.mappingId);
    setLinearProjectId(mapping.linearProjectId);
    setLinearTeamId(mapping.linearTeamId);
    setT3ConnectionId(mapping.t3ConnectionId);
    setT3ProjectId(mapping.t3ProjectId);
    setWorktreeBaseRef(mapping.worktreeBaseRef);
    setTargetBranch(mapping.targetBranch);
    setConfirmingDisable(null);
  }

  function resetForm() {
    setEditingId(null);
    setLinearProjectId("");
    setLinearTeamId("");
    setT3ConnectionId("");
    setT3ProjectId("");
    setWorktreeBaseRef("");
    setTargetBranch("");
  }

  const canSave = useMemo(() => {
    return linearProjectId !== "" && linearTeamId !== "" && t3ConnectionId !== "" &&
      t3ProjectId !== "" && worktreeBaseRef.trim() !== "" && targetBranch.trim() !== "" && !teamBlocked;
  }, [linearProjectId, linearTeamId, t3ConnectionId, t3ProjectId, worktreeBaseRef, targetBranch, teamBlocked]);

  return (
    <div className="w-full max-w-3xl rounded-2xl border bg-white p-8 shadow-sm">
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">Linear mappings</p>
      <h2 className="mt-3 text-2xl font-semibold">Project mappings</h2>
      <p className="mt-2 text-slate-600">
        Map each Linear project and team to its native T3 project. A mapping stores
        the worktree baseRef and the PR target branch as separate values, and a
        disabled mapping never dispatches again.
      </p>
      {notice && <p className="mt-4 text-sm text-slate-600" role="status">{notice}</p>}
      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error.message}</p>}

      <h3 className="mt-6 text-lg font-semibold">Saved mappings</h3>
      {data.mappingsError && <p className="mt-2 text-sm text-red-700" role="alert">{data.mappingsError.message}</p>}
      {data.mappings === null && !data.mappingsError && <p className="mt-2 text-sm text-slate-600" role="status">Loading saved mappings…</p>}
      {data.mappings !== null && data.mappings.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">No mappings saved yet. Create one below.</p>
      )}
      {data.mappings !== null && data.mappings.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.mappings.map((mapping) => (
            <li key={mapping.mappingId} className="rounded-xl border p-4">
              <p className="font-medium">
                {mapping.linearProjectName} · {mapping.linearTeamKey}
                <span className={`ml-2 rounded px-2 py-0.5 text-xs ${mapping.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                  {mapping.enabled ? "Enabled" : "Disabled"}
                </span>
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-slate-600 sm:grid-cols-2">
                <div><dt className="inline font-medium">Linear team: </dt><dd className="inline">{mapping.linearTeamName} ({mapping.linearTeamId})</dd></div>
                <div><dt className="inline font-medium">T3 project: </dt><dd className="inline">{mapping.t3ProjectTitle} ({mapping.t3ProjectId})</dd></div>
                <div><dt className="inline font-medium">Worktree baseRef: </dt><dd className="inline">{mapping.worktreeBaseRef}</dd></div>
                <div><dt className="inline font-medium">PR target branch: </dt><dd className="inline">{mapping.targetBranch}</dd></div>
                <div><dt className="inline font-medium">Started state: </dt><dd className="inline">{mapping.startedStateName}</dd></div>
              </dl>
              <div className="mt-3 flex gap-2">
                <button type="button" className={buttonClass} onClick={() => startEdit(mapping)}>Edit</button>
                {mapping.enabled && confirmingDisable !== mapping.mappingId && (
                  <button type="button" className={buttonClass} onClick={() => setConfirmingDisable(mapping.mappingId)}>Disable</button>
                )}
                {mapping.enabled && confirmingDisable === mapping.mappingId && (
                  <>
                    <button
                      type="button" className={buttonClass} disabled={busy !== null}
                      onClick={() => { setConfirmingDisable(null); onDisable(mapping.mappingId); }}
                    >
                      Confirm disable
                    </button>
                    <button type="button" className={buttonClass} onClick={() => setConfirmingDisable(null)}>Cancel</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-8 text-lg font-semibold">{editingId ? "Edit mapping" : "New mapping"}</h3>
      {data.candidatesError && <p className="mt-2 text-sm text-red-700" role="alert">{data.candidatesError.message}</p>}
      {data.candidates === null && !data.candidatesError && (
        <p className="mt-2 text-sm text-slate-600" role="status">Loading Linear and T3 candidates…</p>
      )}
      {data.candidates !== null && (
        <form
          className="mt-3 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || busy !== null || !selectedProject || !selectedTeam || !selectedConnection || !selectedT3Project) return;
            onSave({
              ...(editingId === null ? {} : { mappingId: editingId }),
              linearProjectId: selectedProject.projectId,
              linearTeamId: selectedTeam.teamId,
              t3ConnectionId: selectedConnection.connectionId,
              t3EnvironmentId: selectedConnection.environmentId,
              t3ProjectId: selectedT3Project.projectId,
              worktreeBaseRef,
              targetBranch,
            });
          }}
        >
          <Field label="Linear project">
            <select
              className={inputClass} value={linearProjectId}
              onChange={(event) => { setLinearProjectId(event.target.value); setLinearTeamId(""); }}
            >
              <option value="">Select a Linear project…</option>
              {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectName}</option>)}
            </select>
          </Field>
          <Field
            label="Linear team"
            hint={selectedTeam?.stateError ?? (selectedTeam ? `Started state: ${selectedTeam.startedStateName}` : undefined)}
          >
            <select
              className={inputClass} value={linearTeamId} disabled={selectedProject === null}
              onChange={(event) => setLinearTeamId(event.target.value)}
            >
              <option value="">Select a team…</option>
              {(selectedProject?.teams ?? []).map((team) => (
                <option key={team.teamId} value={team.teamId}>
                  {team.teamKey} — {team.teamName}{team.stateError ? " (unusable state)" : ""}
                </option>
              ))}
            </select>
          </Field>
          {selectedTeam?.stateError && (
            <p className="text-sm text-red-700" role="alert">
              This team cannot be mapped: {selectedTeam.stateError}
            </p>
          )}
          <Field label="T3 connection">
            <select
              className={inputClass} value={t3ConnectionId}
              onChange={(event) => { setT3ConnectionId(event.target.value); setT3ProjectId(""); }}
            >
              <option value="">Select a T3 connection…</option>
              {t3Connections.map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId} disabled={connection.status !== "connected"}>
                  {connection.environmentId} ({connection.status})
                </option>
              ))}
            </select>
          </Field>
          {selectedConnection?.error && (
            <p className="text-sm text-red-700" role="alert">This T3 connection cannot be used: {selectedConnection.error}</p>
          )}
          <Field label="T3 project">
            <select
              className={inputClass} value={t3ProjectId} disabled={selectedConnection === null}
              onChange={(event) => setT3ProjectId(event.target.value)}
            >
              <option value="">Select a T3 project…</option>
              {(selectedConnection?.projects ?? []).map((project) => (
                <option key={project.projectId} value={project.projectId}>{project.title ?? project.projectId}</option>
              ))}
            </select>
          </Field>
          <Field label="Worktree baseRef" hint="Native worktree baseRef. Never defaults to the PR target branch.">
            <input
              className={inputClass} type="text" value={worktreeBaseRef}
              placeholder="refs/heads/main" autoComplete="off" spellCheck={false}
              onChange={(event) => setWorktreeBaseRef(event.target.value)}
            />
          </Field>
          <Field label="PR target branch" hint="Branch pull requests target. Stored separately from the baseRef.">
            <input
              className={inputClass} type="text" value={targetBranch}
              placeholder="main" autoComplete="off" spellCheck={false}
              onChange={(event) => setTargetBranch(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass} disabled={!canSave || busy !== null}>
              {busy !== null ? "Saving…" : editingId ? "Save changes" : "Create mapping"}
            </button>
            {editingId && <button type="button" className={buttonClass} onClick={resetForm}>Cancel edit</button>}
          </div>
          {!canSave && (
            <p className="text-xs text-slate-500">
              Pick a Linear project and team with a usable started state, a connected T3
              project, and fill in both the baseRef and the target branch.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export function LinearMappingsPanel() {
  const [data, setData] = useState<MappingsData>(emptyData());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<MappingError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const adapter = createLinearMappingsAdapter();
    const controller = new AbortController();
    let active = true;
    (async () => {
      try {
        const [mappings, candidates] = await Promise.all([
          adapter.listMappings(controller.signal),
          adapter.loadCandidates(controller.signal),
        ]);
        if (active) setData({ mappings, mappingsError: null, candidates, candidatesError: null });
      } catch (thrown) {
        if (active) {
          const failure = toMappingError(thrown);
          setData({ mappings: null, mappingsError: failure, candidates: null, candidatesError: failure });
        }
      }
    })();
    return () => { active = false; controller.abort(); };
  }, []);

  async function refresh() {
    const adapter = createLinearMappingsAdapter();
    try {
      const mappings = await adapter.listMappings();
      setData((current) => ({ ...current, mappings, mappingsError: null }));
    } catch (thrown) {
      setData((current) => ({ ...current, mappingsError: toMappingError(thrown) }));
    }
  }

  async function handleSave(input: {
    mappingId?: string;
    linearProjectId: string;
    linearTeamId: string;
    t3ConnectionId: string;
    t3EnvironmentId: string;
    t3ProjectId: string;
    worktreeBaseRef: string;
    targetBranch: string;
  }) {
    setBusy("saving");
    setError(null);
    setNotice(null);
    try {
      const candidates = data.candidates;
      const project = candidates?.projects.find((entry) => entry.projectId === input.linearProjectId);
      const team = project?.teams.find((entry) => entry.teamId === input.linearTeamId);
      const connection = candidates?.t3.connections.find((entry) => entry.connectionId === input.t3ConnectionId);
      const t3Project = connection?.projects.find((entry) => entry.projectId === input.t3ProjectId);
      if (!project || !team || !connection || !t3Project || !candidates) {
        setError({ code: "invalid_request", message: "That destination is no longer available. Reload the candidates and try again.", retryable: false });
        return;
      }
      const adapter = createLinearMappingsAdapter();
      await adapter.saveMapping({
        ...input,
        linearWorkspaceId: candidates.workspace.workspaceId,
        linearProjectName: project.projectName,
        linearTeamKey: team.teamKey,
        linearTeamName: team.teamName,
        t3ProjectTitle: t3Project.title ?? t3Project.projectId,
        ...(team.startedStateId === null || team.startedStateName === null
          ? {}
          : { startedStateId: team.startedStateId, startedStateName: team.startedStateName }),
      });
      setNotice(input.mappingId ? "Mapping saved." : "Mapping created.");
      await refresh();
    } catch (thrown) {
      setError(toMappingError(thrown));
    } finally {
      setBusy(null);
    }
  }

  async function handleDisable(mappingId: string) {
    setBusy("disabling");
    setError(null);
    setNotice(null);
    try {
      await createLinearMappingsAdapter().disableMapping(mappingId);
      setNotice("Mapping disabled. Its history is kept, and it will no longer resolve.");
      await refresh();
    } catch (thrown) {
      setError(toMappingError(thrown));
    } finally {
      setBusy(null);
    }
  }

  return <MappingsView data={data} notice={notice} error={error} busy={busy} onSave={(input) => void handleSave(input)} onDisable={(mappingId) => void handleDisable(mappingId)} />;
}
