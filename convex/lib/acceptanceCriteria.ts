/**
 * Acceptance-criteria extraction — one canonical, pure rule.
 *
 * Deliberately has **no** `"use node"` pragma and **no** imports at all, so it
 * can be shared by both runtimes:
 *
 *   - the Convex action layer (`convex/lib/linearIssues.ts`), which re-exports
 *     it for the issue browser and its tests, and
 *   - the browser-side execution-prompt composer
 *     (`src/features/execute/prompt.ts`).
 *
 * The neighbouring `convex/lib/linearIssues.ts` cannot be imported by the
 * browser: it carries `"use node"` and pulls `node:crypto` in through
 * `linearHelpers`. Keeping this rule in its own dependency-free module means
 * there is exactly one implementation, so the two runtimes cannot drift apart.
 */

/**
 * Derive the acceptance-criteria section only when the description actually
 * contains an `## Acceptance criteria`-style heading. A description without
 * one yields null — never a fabricated section. Content runs until the next
 * markdown heading of any level or the end of the description.
 */
export function extractAcceptanceCriteria(description: string | null | undefined): string | null {
  if (typeof description !== "string" || description.length === 0) return null;
  const lines = description.split("\n");
  const heading = /^#{1,6}\s+acceptance\s+criteria\b.*$/iu;
  const anyHeading = /^#{1,6}\s+\S.*$/u;
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (anyHeading.test(line.trim())) break;
    body.push(line);
  }
  const section = body.join("\n").trim();
  return section.length > 0 ? section : null;
}
