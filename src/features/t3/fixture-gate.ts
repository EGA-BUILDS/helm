/** Literal env checks let Next strip this branch from production client bundles. */
export function fixturesEnabled() {
  return process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_HELM_T3_FIXTURES === "true";
}
