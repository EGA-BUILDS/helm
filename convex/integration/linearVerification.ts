import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const verificationValidator = v.object({
  authentication: v.union(
    v.literal("verified"),
    v.literal("failed"),
    v.literal("inconclusive"),
  ),
  projectAccess: v.union(
    v.literal("verified"),
    v.literal("not_found_or_inaccessible"),
    v.literal("wrong_project"),
    v.literal("not_checked"),
    v.literal("inconclusive"),
  ),
  issuesAccess: v.union(
    v.literal("verified"),
    v.literal("failed"),
    v.literal("not_checked"),
    v.literal("inconclusive"),
  ),
  configuredProjectMatchesHelm: v.union(v.boolean(), v.null()),
  sampledIssueCount: v.union(v.number(), v.null()),
  moreIssuesAvailable: v.union(v.boolean(), v.null()),
  error: v.union(
    v.literal("missing_configuration"),
    v.literal("authentication_rejected"),
    v.literal("linear_api_error"),
    v.literal("linear_unavailable"),
    v.literal("unexpected_response"),
    v.null(),
  ),
});

type LinearVerification = {
  authentication: "verified" | "failed" | "inconclusive";
  projectAccess:
    | "verified"
    | "not_found_or_inaccessible"
    | "wrong_project"
    | "not_checked"
    | "inconclusive";
  issuesAccess: "verified" | "failed" | "not_checked" | "inconclusive";
  configuredProjectMatchesHelm: boolean | null;
  sampledIssueCount: number | null;
  moreIssuesAvailable: boolean | null;
  error:
    | "missing_configuration"
    | "authentication_rejected"
    | "linear_api_error"
    | "linear_unavailable"
    | "unexpected_response"
    | null;
};

const query = `
  query VerifyHelmProjectAccess($projectId: String!) {
    viewer {
      id
    }
    project(id: $projectId) {
      id
      name
      issues(first: 1) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasGraphQLError(errors: unknown[], field: string): boolean {
  return errors.some((error) => {
    if (!isRecord(error) || !Array.isArray(error.path)) return false;
    return error.path.includes(field);
  });
}

function unverifiedResult(
  error: LinearVerification["error"],
  authentication: LinearVerification["authentication"] = "inconclusive",
): LinearVerification {
  return {
    authentication,
    projectAccess: "not_checked",
    issuesAccess: "not_checked",
    configuredProjectMatchesHelm: null,
    sampledIssueCount: null,
    moreIssuesAvailable: null,
    error,
  };
}

export const verifyHelmProjectAccess = internalAction({
  args: {},
  returns: verificationValidator,
  handler: async (): Promise<LinearVerification> => {
    const apiKey = process.env.LINEAR_API_KEY?.trim();
    const projectId = process.env.LINEAR_PROJECT_ID?.trim();
    if (!apiKey || !projectId) {
      return unverifiedResult("missing_configuration");
    }

    let response: Response;
    let body: unknown;
    try {
      response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { projectId } }),
        signal: AbortSignal.timeout(10_000),
      });
      body = await response.json();
    } catch {
      return unverifiedResult("linear_unavailable");
    }

    if (!isRecord(body)) return unverifiedResult("unexpected_response");
    if (response.status === 401) {
      return unverifiedResult("authentication_rejected", "failed");
    }
    if (response.status >= 500 || response.status === 429) {
      return unverifiedResult("linear_unavailable");
    }

    const data = isRecord(body.data) ? body.data : null;
    const viewer = data && isRecord(data.viewer) ? data.viewer : null;
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const authentication: LinearVerification["authentication"] =
      typeof viewer?.id === "string"
        ? "verified"
        : hasGraphQLError(errors, "viewer")
          ? "failed"
          : "inconclusive";

    const project = data && isRecord(data.project) ? data.project : null;
    if (!project) {
      return {
        ...unverifiedResult(
          errors.length > 0 ? "linear_api_error" : "unexpected_response",
          authentication,
        ),
        projectAccess: data?.project === null ? "not_found_or_inaccessible" : "inconclusive",
      };
    }

    const configuredProjectMatchesHelm =
      project.id === projectId && project.name === "Helm";
    const projectAccess: LinearVerification["projectAccess"] =
      typeof project.id !== "string" || typeof project.name !== "string"
        ? "inconclusive"
        : configuredProjectMatchesHelm
          ? "verified"
          : "wrong_project";

    let issuesAccess: LinearVerification["issuesAccess"] = "not_checked";
    let sampledIssueCount: number | null = null;
    let moreIssuesAvailable: boolean | null = null;
    const issues = isRecord(project.issues) ? project.issues : null;
    const nodes = issues && Array.isArray(issues.nodes) ? issues.nodes : null;
    const pageInfo = issues && isRecord(issues.pageInfo) ? issues.pageInfo : null;

    if (projectAccess === "verified") {
      if (hasGraphQLError(errors, "issues")) {
        issuesAccess = "failed";
      } else if (nodes && typeof pageInfo?.hasNextPage === "boolean") {
        issuesAccess = "verified";
        sampledIssueCount = nodes.length;
        moreIssuesAvailable = pageInfo.hasNextPage;
      } else {
        issuesAccess = "inconclusive";
      }
    }

    const error: LinearVerification["error"] =
      response.ok && errors.length === 0
        ? null
        : response.status === 401
          ? "authentication_rejected"
          : errors.length > 0 || !response.ok
            ? "linear_api_error"
            : null;

    return {
      authentication,
      projectAccess,
      issuesAccess,
      configuredProjectMatchesHelm,
      sampledIssueCount,
      moreIssuesAvailable,
      error,
    };
  },
});
