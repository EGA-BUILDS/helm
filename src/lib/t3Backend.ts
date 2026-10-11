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
  if (message === "unauthorized") return { code: "access_denied", message: "Sign in with the Helm owner account to continue.", retryable: false };
  if (message === "backend_unavailable") return { code: "backend_unavailable", message: "The T3 connection service is unavailable.", retryable: true };
  if (message === "cross_origin_request") return { code: "access_denied", message: "This request could not be authorized.", retryable: false };
  if (message.includes("invalid") || message.includes("trusted HTTPS")) return { code: "invalid_endpoint", message: "Enter a supported trusted T3 Connect endpoint.", retryable: false };
  if (message.includes("expired")) return { code: "connection_expired", message: "This T3 authorization expired. Reconnect to continue.", retryable: false };
  return { code: "unknown", message: "The T3 request could not be completed.", retryable: true };
}
