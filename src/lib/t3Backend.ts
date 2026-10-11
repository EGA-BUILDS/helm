import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";

export async function ownerConvexClient(): Promise<ConvexHttpClient> {
  const { userId, getToken } = await auth();
  if (!userId) throw new Error("unauthorized");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("backend_unavailable");
  const token = await getToken({ template: "convex" });
  if (!token) throw new Error("unauthorized");
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

export function requireSameOrigin(request: Request): void {
  const configured = process.env.HELM_APP_URL;
  const origin = request.headers.get("origin");
  let allowedOrigin: string | undefined;
  try { allowedOrigin = configured ? new URL(configured).origin : undefined; } catch { allowedOrigin = undefined; }
  if (!allowedOrigin || !origin || origin !== allowedOrigin) {
    throw new Error("cross_origin_request");
  }
}

export function helmHomeUrl(): URL {
  const configured = process.env.HELM_APP_URL;
  let url: URL;
  try { url = new URL(configured ?? ""); } catch { throw new Error("backend_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("backend_unavailable");
  return new URL("/", url);
}

export function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (message === "unauthorized") return { code: "access_denied", message: "Sign in with the Helm owner account to continue.", retryable: false };
  if (message === "backend_unavailable") return { code: "backend_unavailable", message: "The T3 connection service is unavailable.", retryable: true };
  if (message === "cross_origin_request") return { code: "access_denied", message: "This request could not be authorized.", retryable: false };
  if (normalized.includes("cursor") && normalized.includes("invalid")) return { code: "cursor_invalid", message: "That page cursor is no longer valid. Refresh the list and try again.", retryable: false };
  if (normalized.includes("revoked")) return { code: "revoked", message: "T3 authorization was revoked. Reconnect to continue.", retryable: false };
  if (normalized.includes("expired")) return { code: "connection_expired", message: "This T3 authorization expired. Reconnect to continue.", retryable: false };
  if (/t3 request failed \(429\)/u.test(message)) return { code: "rate_limited", message: "T3 is receiving too many requests. Try again shortly.", retryable: true };
  if (normalized.includes("environment read failed")) return { code: "read_failed", message: "T3 could not complete the environment read.", retryable: true };
  if (normalized.includes("could not be reached") || normalized.includes("timed out") || /t3 request failed \(5\d\d\)/u.test(message)) {
    return { code: "unreachable", message: "The T3 endpoint could not be reached. Try again later.", retryable: true };
  }
  if (message.includes("trusted HTTPS") || normalized.includes("not trusted") || normalized.includes("t3 connect url") ||
      (normalized.includes("invalid") && normalized.includes("endpoint"))) {
    return { code: "invalid_endpoint", message: "Enter a supported trusted T3 Connect endpoint.", retryable: false };
  }
  return { code: "unknown", message: "The T3 request could not be completed.", retryable: true };
}
