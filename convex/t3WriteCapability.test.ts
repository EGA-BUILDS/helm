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

/** The operate-scoped write allowlist (EGA-681). */
function parseWriteToolSet(source: string): string[] {
  const block = source.match(/const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\);/u);
  if (!block) throw new Error("t3OAuth.ts no longer declares a WRITE_TOOLS allowlist");
  return [...block[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

describe("EGA-758: the read path cannot reach a native write, and the operate path reaches only the approved one", () => {
  const t3OAuth = read("t3OAuth.ts");

  it("allowlists exactly the six read tools and nothing else", () => {
    expect(parseToolSet(t3OAuth).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it("reaches no write tool through the allowlist", () => {
    const allowlisted = new Set(parseToolSet(t3OAuth));
    const reachable = WRITE_TOOLS.filter((tool) => allowlisted.has(tool));
    expect(reachable, `write tools became reachable: ${reachable.join(", ")}`).toEqual([]);
  });

  it("keeps two distinct scopes and never requests a broader write scope", () => {
    // EGA-681 replaced the blanket "no operate scope anywhere" assertion with a
    // precise pair. The read-only grant is unchanged; the operate grant is a
    // SEPARATE, explicitly requested scope, and nothing wider exists.
    expect(t3OAuth).toMatch(/const READ_SCOPE = "orchestration:read";/u);
    expect(t3OAuth).toMatch(/const OPERATE_SCOPE = "orchestration:read orchestration:operate";/u);
    expect(t3OAuth).not.toMatch(/source-control:write/u);
    // The read path must request the read scope, and the operate scope must be
    // reachable only through the explicit access selector.
    expect(t3OAuth).toMatch(/requestedAccess === "operate" \? OPERATE_SCOPE : READ_SCOPE/u);
  });

  it("still refuses a grant that exceeds read access", () => {
    expect(t3OAuth).toMatch(/granted permissions beyond read-only access/u);
  });

  it("allows exactly two access levels and never silently upgrades a read-only row", () => {
    // EGA-681 replaced the "access is fixed to read-only" assertion with the
    // precise union. The property that still matters: exactly two levels exist,
    // and there is no third, wider one.
    const schema = read("schema.ts");
    expect(schema).toMatch(/access: v\.union\(\s*v\.literal\("read-only"\),\s*v\.literal\("operate"\),?\s*\)/u);
    expect(schema).not.toMatch(/v\.literal\("full-access"\)/u);
    // A row with no recorded access must be treated as read-only, so legacy rows
    // are never upgraded by omission.
    expect(read("t3ConnectionsStore.ts")).toMatch(/"read-only"/u);
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

it("ships exactly one route per allocated write, and still no unallocated write route", () => {
    // Each allocated write (EGA-681 launch, EGA-764 send, EGA-765 interrupt)
    // gets exactly ONE route. Every route must be owner-gated and same-origin
    // and must delegate to its own action only. The attention GET is a
    // read-only projection and must not touch the interrupt action.
    //
    // This assertion is integration-owned on purpose: the two feature lanes
    // each wrote their own version of it and each DROPPED the other lane's
    // route check. Merging either version verbatim would have silently stopped
    // guarding one of the three write routes while still passing.
    const route = (segments: string[]) => join(here, "..", "src", "app", "api", ...segments, "route.ts");

    const launchRoute = route(["t3", "launch"]);
    expect(existsSync(launchRoute), "the launch route is missing").toBe(true);
    const launchSource = readFileSync(launchRoute, "utf8");
    expect(launchSource).toMatch(/requireSameOrigin\s*\(/u);
    expect(launchSource).toMatch(/api\.t3Launch\.launch\b/u);

    const sendRoute = route(["t3", "threads", "send"]);
    expect(existsSync(sendRoute), "the send route is missing").toBe(true);
    const sendSource = readFileSync(sendRoute, "utf8");
    expect(sendSource).toMatch(/requireSameOrigin\s*\(/u);
    expect(sendSource).toMatch(/api\.t3Send\.send\b/u);
    expect(sendSource).not.toMatch(/api\.t3Launch\.launch\b/u);
    expect(sendSource).not.toMatch(/api\.t3Interrupt\.interrupt\b/u);

    const interruptRoute = route(["t3", "threads", "interrupt"]);
    expect(existsSync(interruptRoute), "the interrupt route is missing").toBe(true);
    const interruptSource = readFileSync(interruptRoute, "utf8");
    expect(interruptSource).toMatch(/requireSameOrigin\s*\(/u);
    expect(interruptSource).toMatch(/api\.t3Interrupt\.interrupt\b/u);
    expect(interruptSource).not.toMatch(/api\.t3Launch\.launch\b/u);
    expect(interruptSource).not.toMatch(/api\.t3Send\.send\b/u);
    expect(interruptSource).not.toMatch(/t3_thread_launch/);
    expect(interruptSource).not.toMatch(/t3_thread_send/);

    // Read-only attention projection: never an interrupt action.
    const attentionRoute = route(["t3", "threads", "attention"]);
    expect(existsSync(attentionRoute), "the attention route is missing").toBe(true);
    const attentionSource = readFileSync(attentionRoute, "utf8");
    expect(attentionSource).toMatch(/api\.t3Attention\.attention\b/u);
    expect(attentionSource).not.toMatch(/api\.t3Interrupt\.interrupt\b/u);

    // the write allowlist is exactly the three allocated tools, nothing else
    expect(parseWriteToolSet(t3OAuth).sort()).toEqual([
      "t3_thread_interrupt",
      "t3_thread_launch",
      "t3_thread_send",
    ]);

    const apiRoot = join(here, "..", "src", "app", "api");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const paths = walk(apiRoot).map((path) => path.slice(apiRoot.length).toLowerCase());

    // Exactly one route per allocated write, and no route for an UNALLOCATED
    // write tool. `t3_thread_fork` is allocated to no issue in v0.2.
    const countOf = (needle: string) => paths.filter((path) => path.includes(needle)).length;
    expect(countOf("launch"), "expected exactly one launch route").toBe(1);
    expect(countOf("/send"), "expected exactly one send route").toBe(1);
    expect(countOf("interrupt"), "expected exactly one interrupt route").toBe(1);
    for (const forbidden of ["fork", "merge-back", "worktree-handoff", "thread-update", "thread-configure"]) {
      expect(countOf(forbidden), `an unallocated write route exists: ${forbidden}`).toBe(0);
    }
  });
});

describe("EGA-758: the capability matrix cannot overstate what is proven", () => {
  const matrixPath = join(here, "..", "doc", "v0.2", "ega-758-write-capability-matrix.json");

  it("exists and is parseable", () => {
    expect(existsSync(matrixPath), "the EGA-758 capability matrix is missing").toBe(true);
    expect(() => JSON.parse(readFileSync(matrixPath, "utf8"))).not.toThrow();
  });

  /**
   * Canonical classification. Hardcoded ON PURPOSE: the first version of this
   * guard only inspected rows whose `kind` was already "write", so a write could
   * be smuggled past it by relabelling it as a read. These lists make the
   * classification itself an assertion.
   */
  const KNOWN_WRITE_OPS = [
    "t3_thread_launch",
    "t3_thread_launch.workspaceStrategy",
    "t3_thread_launch.modelSelection",
    "t3_thread_launch.runtimeMode",
    "t3_thread_send",
    "t3_thread_send.idempotency",
    "t3_thread_interrupt",
    "t3_project_create",
    "t3_pending_request_respond",
    "link_pull_request",
  ];
  const KNOWN_NON_WRITE_OPS = [
    "t3_environment_read",
    "orchestrator_capabilities",
    "t3_project_list",
    "t3_project_read",
    "t3_thread_list",
    "t3_thread_read",
    "t3_pending_request_list",
    "t3_pending_request_read",
    "list_thread_pull_requests",
  ];

  it("keeps every capability claim grounded in a real receipt", () => {
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
      operations: { id: string; kind: string; status: string; proof?: string | null }[];
      probeExecuted?: boolean;
      probeReceipts?: string;
      probeReceiptsSupplementary?: string;
    };
    expect(matrix.operations.length).toBeGreaterThan(0);

    const allowed = new Set(["CONFIRMED", "DENIED", "UNSUPPORTED", "UNKNOWN", "BLOCKED"]);
    for (const operation of matrix.operations) {
      expect(allowed.has(operation.status), `unknown status for ${operation.id}`).toBe(true);
    }
    // The verdict vocabulary must actually contain the verdicts in use, so a
    // status cannot be invented merely by writing it into the file.
    const vocabulary = new Set((matrix as unknown as { statusVocabulary?: string[] }).statusVocabulary ?? []);
    for (const operation of matrix.operations) {
      expect(vocabulary.has(operation.status), `${operation.status} is not in the declared status vocabulary`).toBe(true);
    }

    // 1. Classification cannot be smuggled: a known write op must be a write.
    for (const id of KNOWN_WRITE_OPS) {
      const operation = matrix.operations.find((entry) => entry.id === id);
      expect(operation, `known write operation ${id} is missing from the matrix`).toBeTruthy();
      expect(operation!.kind, `${id} must be classified as a write`).toBe("write");
    }
    for (const id of KNOWN_NON_WRITE_OPS) {
      const operation = matrix.operations.find((entry) => entry.id === id);
      expect(operation, `known non-write operation ${id} is missing from the matrix`).toBeTruthy();
      expect(operation!.kind, `${id} must not be classified as a write`).not.toBe("write");
    }

    // 2. Loading the cited receipts is mandatory, so a claim cannot cite a file
    //    that does not exist or that contains nothing.
    const receiptPaths = [matrix.probeReceipts, matrix.probeReceiptsSupplementary].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    expect(receiptPaths.length).toBeGreaterThan(0);
    let receiptText = "";
    for (const relative of receiptPaths) {
      const absolute = join(here, "..", relative);
      expect(existsSync(absolute), `the cited receipt file ${relative} does not exist`).toBe(true);
      receiptText += readFileSync(absolute, "utf8");
    }

    // 3. A CONFIRMED row must cite a receipt AND its tool must actually appear
    //    in the receipts. Free-text justification is not enough, and a fabricated
    //    row cannot be added without also forging receipt content.
    for (const operation of matrix.operations) {
      const proof = operation.proof ?? null;
      if (operation.status === "CONFIRMED") {
        expect(typeof proof === "string" && proof.trim().length > 0, `${operation.id} is CONFIRMED without citing any proof`).toBe(true);
        // Writes must be grounded in the probe: a cited receipt file AND the tool
        // actually appearing in it. Reads are already permitted by Helm's runtime
        // allowlist, so a stated basis is sufficient for them.
        if (operation.kind === "write") {
          expect(
            receiptPaths.some((relative) => proof!.includes(relative)),
            `${operation.id} is a CONFIRMED write but its proof cites no receipt file`,
          ).toBe(true);
          const tool = operation.id.split(".")[0]!;
          expect(
            receiptText.includes(tool),
            `${operation.id} is a CONFIRMED write but ${tool} does not appear anywhere in the cited receipts`,
          ).toBe(true);
        }
      } else if (operation.status === "UNKNOWN" || operation.status === "BLOCKED") {
        // An unproven or blocked row must NOT carry a proof: a proof implies proof.
        expect(proof, `${operation.id} is ${operation.status} but carries a proof`).toBeNull();
      }
      // DENIED and UNSUPPORTED MAY carry a refusal note; that is evidence too.
    }

    // 4. Claiming any CONFIRMED write also requires the probe to have run.
    const writes = matrix.operations.filter((operation) => operation.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
    if (writes.some((operation) => operation.status === "CONFIRMED")) {
      expect(matrix.probeExecuted).toBe(true);
    }

    // 5. Reads remain CONFIRMED, never overstated the other way.
    for (const operation of matrix.operations.filter((entry) => entry.kind === "read")) {
      expect(operation.status).toBe("CONFIRMED");
    }
  });

  it("keeps the narrative table and the machine-readable matrix in agreement", () => {
    // The first version of this documentation diverged from itself: the summary
    // table marked every write UNKNOWN while the matrix recorded measured
    // results. A reviewer could not tell which statement governed. This asserts
    // that, wherever both documents describe the same operation, they agree.
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
      operations: { id: string; status: string }[];
    };
    const narrative = readFileSync(
      join(here, "..", "doc", "v0.2", "EGA-758-write-capability-matrix.md"),
      "utf8",
    );
    const VERDICTS = ["CONFIRMED", "DENIED", "UNSUPPORTED", "UNKNOWN", "BLOCKED"];
    let compared = 0;
    for (const operation of matrix.operations) {
      const line = narrative
        .split("\n")
        .find((entry) => entry.trimStart().startsWith(`| \`${operation.id}\` `));
      if (!line) continue; // not every operation carries a narrative row
      const verdict = line
        .split("|")
        .map((cell) => cell.trim())
        .find((cell) => VERDICTS.some((word) => cell.replace(/^\*+/, "").startsWith(word)));
      if (!verdict) continue; // tables without a verdict column (the reads table)
      expect(
        verdict.includes(operation.status),
        `${operation.id}: the narrative says "${verdict}" but the matrix says ${operation.status}`,
      ).toBe(true);
      compared += 1;
    }
    // Guard against the check silently comparing nothing.
    expect(compared, "no operation verdicts were compared").toBeGreaterThan(8);
  });

});
