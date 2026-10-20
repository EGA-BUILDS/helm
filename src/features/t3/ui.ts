import type { ConnectionState, Project, Thread } from "./contract";
import { checkT3Endpoint, normalizeEndpointInput, type EndpointRejection } from "../../../convex/lib/t3EndpointPolicy";

export const backendUnavailable = "Unavailable until Helm’s T3 backend is connected.";
export const accessLevels = [
  { id: "read-only", title: "Read only", description: "Read projects, threads, and the provider/model catalog. Cannot change the environment." },
  { id: "operate", title: "Operate", description: "Read everything and send follow-up messages or interrupt runs. Widens access beyond read-only; T3 will show its own consent." },
] as const;
export const connectionCopy: Record<ConnectionState["status"], { title: string; description: string }> = {
  "not-connected": { title: "Connect your T3 environment", description: "Bring your projects, providers, and thread activity into one private workspace." },
  pending: { title: "Waiting for T3 approval", description: "Consent happens at T3. A pending request does not grant Helm access." },
  denied: { title: "Sign-in was denied", description: "No access was granted. A new sign-in would need your approval at T3." },
  expired: { title: "T3 sign-in expired", description: "Approval lasts 30 days. Approve a new sign-in at T3 to restore access." },
  revoked: { title: "T3 authorization was revoked", description: "Access was withdrawn in T3 Settings → Connections. Approve a new sign-in to restore it." },
  unreachable: { title: "T3 endpoint is unreachable", description: "Helm could not reach this T3 server. No project, catalog or thread data is shown until it responds." },
  failed: { title: "T3 connection failed", description: "The connection could not be verified. No live data is available." },
  connected: { title: "Connected", description: "The backend has verified this T3 authorization. T3 remains the source of truth for its projects, catalog, and threads." },
};
/**
 * Owner-facing explanation for each rejection from the shared endpoint policy.
 * Each case names what is actually wrong, so the form never tells the owner a
 * generic HTTP URL is fine when the backend only accepts a trusted HTTPS one.
 */
const endpointRejectionMessages: Record<EndpointRejection, string> = {
  too_long: "That URL is too long. Paste the MCP URL copied from T3 Settings → Connections.",
  malformed: "Enter a complete URL ending in /mcp, for example https://your-environment.t3coderelay.com/mcp.",
  not_https: "T3 Connect URLs must use HTTPS.",
  embedded_credentials: "Remove the username or password from the URL. T3 Connect URLs never embed credentials.",
  query_or_fragment: "Remove the query string or fragment. The MCP URL is only the path ending in /mcp.",
  unsupported_port: "Remove the port number. T3 Connect endpoints use the default HTTPS port.",
  untrusted_host: "Helm only connects to T3 Connect endpoints under t3coderelay.com.",
  not_mcp_path: "The native T3 MCP URL must end in /mcp.",
};

/**
 * Local, early validation that mirrors the backend policy exactly.
 *
 * It decides only whether a URL is *well formed and permitted*; it never claims
 * the endpoint is reachable. The backend remains the final authority.
 */
export function validateEndpoint(value: string): { valid: true; endpoint: string } | { valid: false; message: string } {
  const input = normalizeEndpointInput(value);
  if (!input) return { valid: false, message: "Enter the MCP URL copied from T3 Settings → Connections." };
  if (/\s|\\/u.test(input)) return { valid: false, message: endpointRejectionMessages.malformed };
  const result = checkT3Endpoint(input, { requireMcpPath: true });
  if (!result.ok) return { valid: false, message: endpointRejectionMessages[result.reason] };
  return { valid: true, endpoint: result.url.href };
}

/**
 * Label for the no-saved-connection form.
 *
 * That form is rendered only when there is nothing saved, so its action always
 * starts a *new* connection. A denied or failed attempt must therefore offer
 * Connect again, never a Reconnect that would imply a saved grant exists.
 */
export function connectActionLabel(state: ConnectionState): string {
  return state.status === "pending" ? "Waiting for T3 approval…" : "Connect T3";
}

/** The no-saved-connection action stays disabled while consent is outstanding. */
export function connectActionPending(state: ConnectionState): boolean {
  return state.status === "pending";
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
