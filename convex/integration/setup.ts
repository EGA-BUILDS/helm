import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { isValidIsolatedEndpoint } from "../lib/dispatchConfigValidation";

/**
 * EGA-677 integration setup diagnostics (INTERNAL ONLY).
 *
 * Reports whether each server-side integration variable is present, WITHOUT
 * revealing any value. Registered with `internalAction`, so it is not callable
 * from a browser, the Convex client SDK, or any public HTTP surface.
 *
 * Every check reports one of a small, closed set of states so the UI can render
 * an actionable message:
 *   - `missing`      -> the owner has not supplied the variable yet
 *   - `configured`   -> present and non-empty (never show the value)
 *   - `placeholder`  -> still the `.env.example` placeholder
 *
 * This action reads environment configuration only. It performs no network
 * call, no discovery, and no mutation.
 */

const placeholderValues = new Set([
  "https://YOUR_PUBLIC_T3_MCP_ENDPOINT/mcp",
  "https://YOUR_ISOLATED_T3_MCP_ENDPOINT/mcp",
  "https://YOUR_CONVEX_DEPLOYMENT_URL",
  "https://YOUR_CONVEX_SITE_URL",
]);

export type SetupCheckName =
  | "t3McpUrl"
  | "t3McpToken"
  | "t3McpUrlIsolated"
  | "t3McpTokenIsolated"
  | "t3ProjectIdIsolated"
  | "linearApiKey"
  | "linearProjectId"
  | "clerkIssuerDomain"
  | "ownerSubject";

export type SetupCheckState = "missing" | "configured" | "placeholder" | "invalid";

/**
 * Whether the ISOLATED dispatch configuration permits dispatch (M-3).
 *
 * This is deliberately NOT a boolean derived from hosted discovery: a fully
 * configured PRIVILEGED discovery pair never implies that dispatch may run,
 * because dispatch talks only to the isolated instance. Missing isolated
 * credentials fail closed — `isolated_not_configured` / `isolated_incomplete`
 * — and only a fully configured isolated pair is `isolated_configured`.
 */
export type DispatchEligibility =
  | "isolated_configured"
  | "isolated_incomplete"
  | "isolated_invalid"
  | "isolated_not_configured";

export type SetupReport = {
  checks: Array<{
    name: SetupCheckName;
    /** Variable name, safe to display. Never the value. */
    variable: string;
    state: SetupCheckState;
    /** Actionable, human-readable guidance. Contains no secret material. */
    message: string;
  }>;
  /**
   * True when the variables required for **T3 hosted discovery** (EGA-677) are
   * set. Discovery talks to the PRIVILEGED instance and is a READ-ONLY
   * capability: it never implies that dispatch may run. Linear/Clerk/owner
   * checks are reported for visibility but are required by later phases
   * (EGA-678/679), not by this one.
   */
  readyForHostedDiscovery: boolean;
  /**
   * True only when the isolated endpoint, token, and trusted project binding are configured.
   * Independent of `readyForHostedDiscovery`: privileged discovery readiness
   * must never be read as dispatch readiness.
   */
  readyForIsolatedDispatch: boolean;
  /** Distinct dispatch-eligibility status; see `DispatchEligibility`. */
  dispatchEligibility: DispatchEligibility;
};

const guidance: Record<SetupCheckName, string> = {
  t3McpUrl:
    "Set T3_MCP_URL in Convex environment settings to a public HTTPS URL that reaches the T3 Code MCP server from the hosted Convex runtime. Loopback and Tailscale addresses are not reachable; see doc/configuration-checklist.md. This variable is for PRIVILEGED DISCOVERY ONLY and is never used for dispatch.",
  t3McpToken:
    "Set T3_MCP_TOKEN in Convex environment settings. Issue it server-side with `t3 auth session issue` after confirming which credential form /mcp accepts. Never log or expose this value. This variable is for PRIVILEGED DISCOVERY ONLY and is never used for dispatch.",
  t3McpUrlIsolated:
    "Set T3_MCP_URL_ISOLATED in Convex environment settings to the HTTPS URL of the ISOLATED T3 instance dispatch is allowed to launch on. Dispatch reads ONLY this endpoint; T3_MCP_URL is never a fallback for it.",
  t3McpTokenIsolated:
    "Set T3_MCP_TOKEN_ISOLATED in Convex environment settings to the bearer credential for the ISOLATED T3 instance. Dispatch reads ONLY this token; T3_MCP_TOKEN is never a fallback for it. Missing isolated credentials disable dispatch entirely (fail closed).",
  t3ProjectIdIsolated:
    "Set T3_PROJECT_ID_ISOLATED to the exact trusted T3 project identifier allowed for dispatch. Caller-supplied project IDs must match it; missing binding disables dispatch.",
  linearApiKey:
    "Set LINEAR_API_KEY in Convex environment settings using a Linear personal API key (read-only). Never expose it to the browser.",
  linearProjectId:
    "Set LINEAR_PROJECT_ID in Convex environment settings to the target Linear project UUID.",
  clerkIssuerDomain:
    "Set CLERK_FRONTEND_API_URL in Convex environment settings to the Clerk Frontend API issuer used by convex/auth.config.ts.",
  ownerSubject:
    "Set HELM_OWNER_SUBJECT in Convex environment settings to the owner's immutable identity. It is enforced server-side and must never be accepted from a client.",
};

const variables: Record<SetupCheckName, string> = {
  t3McpUrl: "T3_MCP_URL",
  t3McpToken: "T3_MCP_TOKEN",
  t3McpUrlIsolated: "T3_MCP_URL_ISOLATED",
  t3McpTokenIsolated: "T3_MCP_TOKEN_ISOLATED",
  t3ProjectIdIsolated: "T3_PROJECT_ID_ISOLATED",
  linearApiKey: "LINEAR_API_KEY",
  linearProjectId: "LINEAR_PROJECT_ID",
  clerkIssuerDomain: "CLERK_FRONTEND_API_URL",
  ownerSubject: "HELM_OWNER_SUBJECT",
};

/**
 * Closed validators make it structurally impossible for this action to return
 * a credential value: the object shape has no field that could hold one.
 */
const setupCheckValidator = v.object({
  name: v.string(),
  variable: v.string(),
  state: v.union(
    v.literal("missing"),
    v.literal("configured"),
    v.literal("placeholder"),
    v.literal("invalid"),
  ),
  message: v.string(),
});

const setupReportValidator = v.object({
  checks: v.array(setupCheckValidator),
  readyForHostedDiscovery: v.boolean(),
  readyForIsolatedDispatch: v.boolean(),
  dispatchEligibility: v.union(
    v.literal("isolated_configured"),
    v.literal("isolated_incomplete"),
    v.literal("isolated_invalid"),
    v.literal("isolated_not_configured"),
  ),
});

export const reportIntegrationSetup = internalAction({
  args: {},
  returns: setupReportValidator,
  handler: async (): Promise<SetupReport> => {
    // Read presence only. Values are deliberately never returned.
    const present: Record<SetupCheckName, string | undefined> = {
      t3McpUrl: process.env.T3_MCP_URL,
      t3McpToken: process.env.T3_MCP_TOKEN,
      t3McpUrlIsolated: process.env.T3_MCP_URL_ISOLATED,
      t3McpTokenIsolated: process.env.T3_MCP_TOKEN_ISOLATED,
      t3ProjectIdIsolated: process.env.T3_PROJECT_ID_ISOLATED,
      linearApiKey: process.env.LINEAR_API_KEY,
      linearProjectId: process.env.LINEAR_PROJECT_ID,
      clerkIssuerDomain: process.env.CLERK_FRONTEND_API_URL,
      ownerSubject: process.env.HELM_OWNER_SUBJECT,
    };

    const checks = (Object.keys(variables) as SetupCheckName[]).map((name) => {
      const raw = present[name];
      const trimmed = raw?.trim() ?? "";

      let state: SetupCheckState;
      if (trimmed === "") {
        state = "missing";
      } else if (placeholderValues.has(trimmed)) {
        state = "placeholder";
      } else if (name === "t3McpUrlIsolated" && !isValidIsolatedEndpoint(trimmed)) {
        state = "invalid";
      } else {
        state = "configured";
      }

      const message =
        state === "configured"
          ? `${variables[name]} is set.`
          : state === "placeholder"
            ? `${variables[name]} still holds an example placeholder. ${guidance[name]}`
            : state === "invalid"
              ? `${variables[name]} is invalid; isolated dispatch is disabled. Use an absolute HTTPS URL without userinfo.`
            : guidance[name];

      return { name, variable: variables[name], state, message };
    });

    const byName = new Map(checks.map((c) => [c.name, c]));
    const readyForHostedDiscovery =
      byName.get("t3McpUrl")?.state === "configured" &&
      byName.get("t3McpToken")?.state === "configured";

    // M-3: dispatch eligibility is computed from the ISOLATED pair alone.
    // The privileged pair contributes nothing here: a passing discovery check
    // must never imply that dispatch may run.
    const isolatedUrlState = byName.get("t3McpUrlIsolated")?.state;
    const isolatedTokenState = byName.get("t3McpTokenIsolated")?.state;
    const isolatedProjectState = byName.get("t3ProjectIdIsolated")?.state;
    const readyForIsolatedDispatch =
      isolatedUrlState === "configured" &&
      isolatedTokenState === "configured" &&
      isolatedProjectState === "configured";
    const dispatchEligibility: DispatchEligibility = readyForIsolatedDispatch
      ? "isolated_configured"
      : isolatedUrlState === "invalid"
        ? "isolated_invalid"
      : isolatedUrlState === "missing" &&
          isolatedTokenState === "missing"
        ? "isolated_not_configured"
        : "isolated_incomplete";

    return { checks, readyForHostedDiscovery, readyForIsolatedDispatch, dispatchEligibility };
  },
});
