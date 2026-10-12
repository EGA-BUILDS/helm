import type { ConnectionState, Project, Thread } from "./contract";

export const backendUnavailable = "Unavailable until Helm’s T3 backend is connected.";
export const accessLevels = [
  { id: "read-only", title: "Read only", description: "Read projects, threads, and the provider/model catalog. Cannot change the environment." },
  { id: "supervised", title: "Supervised", description: "Can start, message, and stop threads within the approved mode limits. T3 handles approval prompts." },
  { id: "full-access", title: "Full access", description: "Can start, message, and stop threads within the approved mode limits. Review this broader permission at T3." },
] as const;
export const connectionCopy: Record<ConnectionState["status"], { title: string; description: string }> = {
  "not-connected": { title: "Connect your T3 environment", description: "Bring your projects, providers, and thread activity into one private workspace." },
  pending: { title: "Waiting for T3 approval", description: "Consent happens at T3. A pending request does not grant Helm access." },
  denied: { title: "Sign-in was denied", description: "No access was granted. A new sign-in would need your approval at T3." },
  expired: { title: "T3 sign-in expired", description: "Approval lasts 30 days. Approve a new sign-in at T3 to restore access." },
  failed: { title: "T3 connection failed", description: "The connection could not be verified. No live data is available." },
  connected: { title: "Connected", description: "The backend has verified this T3 authorization. T3 remains the source of truth for its projects, catalog, and threads." },
};
export function validateEndpoint(value: string): { valid: true; endpoint: string } | { valid: false; message: string } {
  const input = value.trim();
  if (!input) return { valid: false, message: "Enter the MCP URL copied from T3 Settings → Connections." };
  try {
    if (!/^https?:\/\/[^/]/i.test(input) || /[\s\\]/.test(input)) throw new Error();
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error();
    if (url.username || url.password || input.includes("?") || input.includes("#")) {
      return { valid: false, message: "Use an endpoint without credentials, query parameters, or a fragment." };
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      return { valid: false, message: "The native T3 MCP URL must end in /mcp." };
    }
    url.pathname = "/mcp";
    return { valid: true, endpoint: url.href };
  } catch {
    return { valid: false, message: "Enter a complete HTTP or HTTPS URL ending in /mcp." };
  }
}
export function filterProjects(projects: readonly Project[], query: string) {
  const search = query.trim().toLocaleLowerCase();
  return projects.filter((project) => [project.title, project.projectId, project.workspaceRoot, project.environmentId, project.repositoryIdentity].some((value) => value?.toLocaleLowerCase().includes(search)));
}
export function filterThreads(threads: readonly Thread[], query: string, projectId: string) {
  const search = query.trim().toLocaleLowerCase();
  return threads.filter((thread) => (!projectId || thread.projectId === projectId) && [thread.title, thread.threadId, thread.status, thread.model].some((value) => value?.toLocaleLowerCase().includes(search)));
}
export function threadReference(threadId: string) {
  return `t3-thread://v1/${threadId}`;
}
