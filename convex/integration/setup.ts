import { v } from "convex/values";
import { internalAction } from "../_generated/server";

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
  "https://YOUR_CONVEX_DEPLOYMENT_URL",
  "https://YOUR_CONVEX_SITE_URL",
]);

export type SetupCheckName =
  | "t3McpUrl"
  | "t3McpToken"
  | "linearApiKey"
  | "linearProjectId"
  | "clerkIssuerDomain"
  | "ownerSubject";

export type SetupCheckState = "missing" | "configured" | "placeholder";

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
   * set. Linear/Clerk/owner checks are reported for visibility but are required
   * by later phases (EGA-678/679), not by this one.
   */
  readyForHostedDiscovery: boolean;
};

const guidance: Record<SetupCheckName, string> = {
  t3McpUrl:
    "Set T3_MCP_URL in Convex environment settings to a public HTTPS URL that reaches the T3 Code MCP server from the hosted Convex runtime. Loopback and Tailscale addresses are not reachable; see doc/configuration-checklist.md.",
  t3McpToken:
    "Set T3_MCP_TOKEN in Convex environment settings. Issue it server-side with `t3 auth session issue` after confirming which credential form /mcp accepts. Never log or expose this value.",
  linearApiKey:
    "Set LINEAR_API_KEY in Convex environment settings using a Linear personal API key (read-only). Never expose it to the browser.",
  linearProjectId:
    "Set LINEAR_PROJECT_ID in Convex environment settings to the target Linear project UUID.",
  clerkIssuerDomain:
    "Set CLERK_ISSUER_DOMAIN in Convex environment settings to the Clerk JWT issuer domain used by convex/auth.config.ts.",
  ownerSubject:
    "Set HELM_OWNER_SUBJECT in Convex environment settings to the owner's immutable identity. It is enforced server-side and must never be accepted from a client.",
};

const variables: Record<SetupCheckName, string> = {
  t3McpUrl: "T3_MCP_URL",
  t3McpToken: "T3_MCP_TOKEN",
  linearApiKey: "LINEAR_API_KEY",
  linearProjectId: "LINEAR_PROJECT_ID",
  clerkIssuerDomain: "CLERK_ISSUER_DOMAIN",
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
  ),
  message: v.string(),
});

const setupReportValidator = v.object({
  checks: v.array(setupCheckValidator),
  readyForHostedDiscovery: v.boolean(),
});

export const reportIntegrationSetup = internalAction({
  args: {},
  returns: setupReportValidator,
  handler: async (): Promise<SetupReport> => {
    // Read presence only. Values are deliberately never returned.
    const present: Record<SetupCheckName, string | undefined> = {
      t3McpUrl: process.env.T3_MCP_URL,
      t3McpToken: process.env.T3_MCP_TOKEN,
      linearApiKey: process.env.LINEAR_API_KEY,
      linearProjectId: process.env.LINEAR_PROJECT_ID,
      clerkIssuerDomain: process.env.CLERK_ISSUER_DOMAIN,
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
      } else {
        state = "configured";
      }

      const message =
        state === "configured"
          ? `${variables[name]} is set.`
          : state === "placeholder"
            ? `${variables[name]} still holds an example placeholder. ${guidance[name]}`
            : guidance[name];

      return { name, variable: variables[name], state, message };
    });

    const byName = new Map(checks.map((c) => [c.name, c]));
    const readyForHostedDiscovery =
      byName.get("t3McpUrl")?.state === "configured" &&
      byName.get("t3McpToken")?.state === "configured";

    return { checks, readyForHostedDiscovery };
  },
});