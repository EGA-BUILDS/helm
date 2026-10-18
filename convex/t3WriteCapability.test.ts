import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * EGA-758 write-capability guards.
 *
 * External-OAuth **write** invocability has NOT been proven against the installed
 * T3 server. `tools/list` is not scope-filtered, so a token scoped
 * `orchestration:read` still *sees* every write tool — discoverability is not
 * permission. Until the owner-authorized disposable DEV probe in
 * `doc/v0.2/EGA-758-write-capability-matrix.md` produces authentic receipts, Helm
 * must remain incapable of reaching a native write.
 *
 * These tests assert that incapability **from source**, so the boundary cannot be
 * widened by accident. They are deliberately source-based, matching the idiom
 * already used by `convex/authz.test.ts`: a future `export const x = ...` or a
 * widened allowlist fails the build instead of quietly shipping.
 *
 * If a future issue legitimately proves and enables a write operation, this file
 * must be changed in the same commit — which is the point. Proving capability is
 * a deliberate, reviewable act, never a side effect.
 */

const here = import.meta.dirname;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

/** Tools the external-OAuth connection is allowed to invoke today: reads only. */
const READ_ONLY_TOOLS = [
  "t3_environment_read",
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_read",
];

/** Native write tools observed in the provider-session surface. None are reachable by Helm. */
const WRITE_TOOLS = [
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_update",
  "t3_thread_interrupt",
  "t3_thread_fork",
  "t3_thread_merge_back",
  "t3_thread_configure",
  "t3_thread_organize",
  "t3_worktree_handoff",
  "t3_thread_send_attachments",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_environment_preferences_update",
  "create_threads",
  "delegate_task",
  "schedule_task",
  "update_scheduled_task",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  "link_pull_request",
  "unlink_pull_request",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "device_open",
  "device_close",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
];

function parseToolSet(source: string): string[] {
  const block = source.match(/const TOOLS = new Set\(\[([\s\S]*?)\]\);/u);
  if (!block) throw new Error("t3OAuth.ts no longer declares a TOOLS allowlist");
  return [...block[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

describe("EGA-758: the external-OAuth connection cannot reach a native write", () => {
  const t3OAuth = read("t3OAuth.ts");

  it("allowlists exactly the six read tools and nothing else", () => {
    expect(parseToolSet(t3OAuth).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it("reaches no write tool through the allowlist", () => {
    const allowlisted = new Set(parseToolSet(t3OAuth));
    const reachable = WRITE_TOOLS.filter((tool) => allowlisted.has(tool));
    expect(reachable, `write tools became reachable: ${reachable.join(", ")}`).toEqual([]);
  });

  it("requests and accepts only the read scope", () => {
    expect(t3OAuth).toMatch(/const READ_SCOPE = "orchestration:read";/u);
    // An operate-rate scope must never appear in the read-only OAuth module.
    expect(t3OAuth).not.toMatch(/orchestration:operate/u);
    expect(t3OAuth).not.toMatch(/source-control:write/u);
  });

  it("still refuses a grant that exceeds read access", () => {
    expect(t3OAuth).toMatch(/granted permissions beyond read-only access/u);
  });

  it("keeps the stored connection access level fixed to read-only", () => {
    // The schema is the durable record of what the grant is for. A widened
    // literal here would silently legitimise writes for existing rows.
    expect(read("schema.ts")).toMatch(/access: v\.literal\("read-only"\)/u);
  });

  it("exposes no write operation through the T3 read route", () => {
    const route = readFileSync(
      join(here, "..", "src", "app", "api", "t3", "connections", "[connectionId]", "[operation]", "route.ts"),
      "utf8",
    );
    const block = route.match(/const allowed = new Set\(\[([\s\S]*?)\]\);/u);
    if (!block) throw new Error("the T3 read route no longer declares an operation allowlist");
    const operations = [...block[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    expect(operations.sort()).toEqual(
      ["capabilities", "environment", "project", "projects", "thread", "threads"].sort(),
    );
    for (const forbidden of ["launch", "send", "interrupt", "worktree", "create"]) {
      expect(operations).not.toContain(forbidden);
    }
  });

  it("ships no launch, send or interrupt route at all", () => {
    const apiRoot = join(here, "..", "src", "app", "api");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const paths = walk(apiRoot).map((path) => path.slice(apiRoot.length).toLowerCase());
    for (const forbidden of ["launch", "send", "interrupt"]) {
      const offenders = paths.filter((path) => path.includes(forbidden));
      expect(offenders, `a ${forbidden} route exists: ${offenders.join(", ")}`).toEqual([]);
    }
  });
});

describe("EGA-758: the capability matrix cannot overstate what is proven", () => {
  const matrixPath = join(here, "..", "doc", "v0.2", "ega-758-write-capability-matrix.json");

  it("exists and is parseable", () => {
    expect(existsSync(matrixPath), "the EGA-758 capability matrix is missing").toBe(true);
    expect(() => JSON.parse(readFileSync(matrixPath, "utf8"))).not.toThrow();
  });

  it("allows a write to be CONFIRMED only when it cites a real probe receipt", () => {
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
      operations: { id: string; kind: string; status: string; proof?: string | null }[];
      probeExecuted?: boolean;
      probeReceipts?: string;
    };
    expect(matrix.operations.length).toBeGreaterThan(0);

    const allowed = new Set(["CONFIRMED", "UNKNOWN", "UNSUPPORTED", "DENIED", "BLOCKED"]);
    for (const operation of matrix.operations) {
      expect(allowed.has(operation.status), `unknown status for ${operation.id}`).toBe(true);
    }

    // The rule that replaced "writes may never be CONFIRMED".
    //
    // The live probe has now run, so blanket-unproven is no longer the truth.
    // The property that still matters is that the matrix cannot OVERSTATE what
    // is proven: nothing may be CONFIRMED without a citation, and nothing may
    // carry a citation without being CONFIRMED. A future write row cannot be
    // claimed as working merely by editing this JSON — it needs a proof string
    // pointing at receipts.
    const writes = matrix.operations.filter((operation) => operation.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const operation of writes) {
      const proof = operation.proof ?? null;
      if (operation.status === "CONFIRMED") {
        expect(
          typeof proof === "string" && proof.trim().length > 0,
          `${operation.id} is CONFIRMED without citing any proof`,
        ).toBe(true);
      } else {
        expect(
          proof,
          `${operation.id} carries a proof but is not CONFIRMED (${operation.status})`,
        ).toBeNull();
      }
    }

    // If any write is claimed CONFIRMED, the matrix must name the receipt file
    // it is based on and say that the probe actually ran.
    const anyConfirmedWrite = writes.some((operation) => operation.status === "CONFIRMED");
    if (anyConfirmedWrite) {
      expect(matrix.probeExecuted).toBe(true);
      expect(typeof matrix.probeReceipts).toBe("string");
      expect(matrix.probeReceipts!.length).toBeGreaterThan(0);
      // and that receipt file must actually exist in the repo
      expect(
        existsSync(join(here, "..", matrix.probeReceipts!)),
        `the cited receipt file ${matrix.probeReceipts} does not exist`,
      ).toBe(true);
    }

    // Reads must still be CONFIRMED, never overstated the other way.
    for (const operation of matrix.operations.filter((entry) => entry.kind === "read")) {
      expect(operation.status).toBe("CONFIRMED");
    }
  });
});
