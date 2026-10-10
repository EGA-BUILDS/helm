/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  ISOLATED_ENDPOINT_VAR,
  ISOLATED_TOKEN_VAR,
  isolatedConfigDetail,
  resolveIsolatedDispatchConfig,
} from "./lib/dispatchConfig";

/**
 * EGA-677 dispatch safety (isolated credential resolution).
 *
 * The defect these tests pin down: dispatch used to read
 *
 *     process.env.T3_MCP_URL_ISOLATED ?? process.env.T3_MCP_URL
 *
 * so a deployment whose isolated pair was not configured silently fell back to
 * the PRIVILEGED instance's endpoint and token. That is a privilege escalation
 * disguised as a default: "isolated" work would run with the owner's real
 * credential, against the real workspace.
 *
 * These tests are deterministic and hermetic. `globalThis.fetch` is replaced
 * with a recording stub that never leaves the process, so there are no real T3
 * MCP calls, no token exchanges and no launches anywhere in this file.
 */

const modules = import.meta.glob("./**/*.ts");

/**
 * Restore the owner identity environment after each test. `seedActiveCredential`
 * sets it because the merged dispatch path revalidates the grant, and a value
 * leaking into another test file would silently authorise the wrong identity.
 */
afterEach(() => {
  delete process.env.HELM_OWNER_SUBJECT;
  delete process.env.CLERK_FRONTEND_API_URL;
});

/** What one outbound HTTP attempt looked like. */
type FetchCall = { url: string; authorization: string | null };

function recordFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  const describe = (input: unknown, init: unknown): FetchCall => {
    let url = "";
    if (typeof input === "string") url = input;
    else if (input instanceof Request) {
      url = input.url;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === "object" && "href" in input) {
      url = String((input as { href: unknown }).href);
    } else {
      url = String(input);
    }
    // The MCP transport passes a real `Headers` instance, whose entries are not
    // own properties, so a plain-record lookup alone would silently read null.
    let authorization: string | null = null;
    const headers = init && typeof init === "object" ? (init as { headers?: unknown }).headers : undefined;
    if (headers instanceof Headers) {
      authorization = headers.get("authorization");
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, unknown>;
      authorization =
        typeof record.Authorization === "string"
          ? record.Authorization
          : typeof record.authorization === "string"
            ? record.authorization
            : null;
    }
    if (input instanceof Request) {
      const header = input.headers.get("authorization");
      if (header) authorization = header;
    }
    return { url, authorization };
  };
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    calls.push(describe(input, init));
    return Promise.reject(new Error("DISPATCH_TEST_FETCH_BLOCKED"));
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const PROVIDER = "t3-mcp";
const ISSUE = "EGA-677";
const PROJECT = "mcp:project";
const AT = 1_700_000_000_000;

const PRIVILEGED_ENDPOINT = "https://privileged.example.invalid/mcp";
const PRIVILEGED_TOKEN = "PRIVILEGED_TOKEN_SENTINEL";
const ISOLATED_ENDPOINT = "https://isolated.example.invalid/mcp";
const ISOLATED_TOKEN = "ISOLATED_TOKEN_SENTINEL";

/**
 * Owner authority the MERGED dispatchIssue / reconcileAttempt now require.
 *
 * EGA-677 and EGA-678 are integrated here, so every dispatch path carries BOTH
 * controls at once: an owner grant revalidated on execution, AND an
 * isolated-only credential pair. Neither gate may be satisfied in place of the
 * other. These values are placeholders, never a real identity.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";

/**
 * Seed an active credential AND the active owner grant, because the MERGED
 * dispatch path requires both: the isolated-credential gate (EGA-677) and the
 * owner-grant gate (EGA-678). Returns the grant so a caller can pass it as the
 * `ownerGrant` argument.
 */
async function seedActiveCredential(t: ReturnType<typeof convexTest>): Promise<{ revision: number }> {
  await t.mutation(internal.credentials.recordCredential, {
    provider: PROVIDER,
    scopes: ["orchestration:read", "orchestration:operate"],
    issuedAt: AT,
    expiresAt: AT + 1_000_000,
  });
  // Owner environment must be configured for grantOwner/assertCurrentGrant to
  // accept the placeholder identity.
  process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
  process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  return await t.mutation(internal.auth.grantOwner, {
    subject: OWNER_SUBJECT,
    issuer: OWNER_ISSUER,
  });
}

/** The `ownerGrant` argument every merged dispatch entry point now requires. */
function ownerGrantFor(grant: { revision: number }) {
  return { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER, revision: grant.revision };
}

const attemptsIn = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => await ctx.db.query("launchAttempts").collect());

/**
 * Run `fn` with all four T3 variables in a known state, restoring the originals
 * afterwards. Everything is explicit so one test cannot leak configuration into
 * another.
 */
async function withEnv(
  values: {
    url?: string;
    token?: string;
    isolatedUrl?: string;
    isolatedToken?: string;
  },
  fn: () => Promise<void>,
): Promise<void> {
  const keys = ["T3_MCP_URL", "T3_MCP_TOKEN", ISOLATED_ENDPOINT_VAR, ISOLATED_TOKEN_VAR];
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) delete process.env[key];
  const set: Record<string, string | undefined> = {
    T3_MCP_URL: values.url,
    T3_MCP_TOKEN: values.token,
    [ISOLATED_ENDPOINT_VAR]: values.isolatedUrl,
    [ISOLATED_TOKEN_VAR]: values.isolatedToken,
  };
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const dispatchSource = readFileSync(join(import.meta.dirname, "dispatch.ts"), "utf8");
const configSource = readFileSync(join(import.meta.dirname, "lib", "dispatchConfig.ts"), "utf8");

/**
 * Source lines with comments and blanks removed, so an assertion about the CODE
 * cannot be satisfied (or defeated) by prose in a doc comment.
 */
function codeLinesOf(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

describe("isolated credential resolution (unit)", () => {
  it("refuses when the isolated endpoint is not configured", () => {
    const r = resolveIsolatedDispatchConfig({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("isolated_endpoint_not_configured");
    expect(isolatedConfigDetail(r)).toContain(ISOLATED_ENDPOINT_VAR);
  });

  it("refuses when the isolated token is not configured", () => {
    const r = resolveIsolatedDispatchConfig({ [ISOLATED_ENDPOINT_VAR]: ISOLATED_ENDPOINT });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("isolated_token_not_configured");
    expect(isolatedConfigDetail(r)).toContain(ISOLATED_TOKEN_VAR);
  });

  it("refuses a whitespace-only configuration instead of building a blank transport", () => {
    expect(
      resolveIsolatedDispatchConfig({
        [ISOLATED_ENDPOINT_VAR]: "   ",
        [ISOLATED_TOKEN_VAR]: "\n\t",
      }).ok,
    ).toBe(false);
  });

  it("refuses an endpoint that is not https", () => {
    const r = resolveIsolatedDispatchConfig({
      [ISOLATED_ENDPOINT_VAR]: "http://isolated.example.invalid/mcp",
      [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("isolated_endpoint_invalid");
  });

  it("refuses an endpoint with no host", () => {
    expect(
      resolveIsolatedDispatchConfig({
        [ISOLATED_ENDPOINT_VAR]: "https://",
        [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN,
      }).ok,
    ).toBe(false);
  });

  it("refuses an endpoint carrying embedded userinfo", () => {
    const r = resolveIsolatedDispatchConfig({
      [ISOLATED_ENDPOINT_VAR]: "https://user:hunter2@isolated.example.invalid/mcp",
      [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("isolated_endpoint_invalid");
  });

  it("accepts a fully configured isolated pair and trims it", () => {
    const r = resolveIsolatedDispatchConfig({
      [ISOLATED_ENDPOINT_VAR]: `${ISOLATED_ENDPOINT}  `,
      [ISOLATED_TOKEN_VAR]: `  ${ISOLATED_TOKEN}`,
    });
    expect(r).toEqual({ ok: true, endpoint: ISOLATED_ENDPOINT, token: ISOLATED_TOKEN });
  });

  /** The dependency-injection seam: nothing configured but the privileged pair. */
  it("ignores the privileged variables entirely", () => {
    expect(
      resolveIsolatedDispatchConfig({
        T3_MCP_URL: PRIVILEGED_ENDPOINT,
        T3_MCP_TOKEN: PRIVILEGED_TOKEN,
      }).ok,
    ).toBe(false);
  });

  it("never returns a credential value in a refusal detail", () => {
    const sentinels = [
      PRIVILEGED_ENDPOINT,
      PRIVILEGED_TOKEN,
      ISOLATED_ENDPOINT,
      ISOLATED_TOKEN,
      "https://user:hunter2@isolated.example.invalid/mcp",
      "http://isolated.example.invalid/mcp",
    ];
    const cases = [
      {},
      { T3_MCP_URL: PRIVILEGED_ENDPOINT, T3_MCP_TOKEN: PRIVILEGED_TOKEN },
      { [ISOLATED_ENDPOINT_VAR]: ISOLATED_ENDPOINT },
      { [ISOLATED_ENDPOINT_VAR]: ISOLATED_ENDPOINT, [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN },
      {
        [ISOLATED_ENDPOINT_VAR]: "http://isolated.example.invalid/mcp",
        [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN,
      },
      {
        [ISOLATED_ENDPOINT_VAR]: "https://user:hunter2@isolated.example.invalid/mcp",
        [ISOLATED_TOKEN_VAR]: ISOLATED_TOKEN,
      },
    ];
    for (const env of cases) {
      const r = resolveIsolatedDispatchConfig(env);
      const detail = r.ok ? "" : isolatedConfigDetail(r);
      for (const sentinel of sentinels) {
        expect(detail).not.toContain(sentinel);
      }
    }
  });
});

describe("dispatch fails closed (behavioural)", () => {
  it("missing endpoint: no MCP call, no attempt recorded", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv({ isolatedToken: ISOLATED_TOKEN }, async () => {
      const recorder = recordFetch();
      let res;
      try {
        res = await t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        });
      } finally {
        recorder.restore();
      }
      expect(res.outcome).toBe("paused");
      expect(res.detail).toContain(ISOLATED_ENDPOINT_VAR);
      expect(res.attemptId).toBe(null);
      expect(res.correlationKey).toBe(null);
      expect(res.threadId).toBe(null);
      expect(res.relaunchAuthorized).toBe(false);
      // Nothing was dispatched, so nothing may have been attempted.
      expect(recorder.calls).toEqual([]);
      expect(await attemptsIn(t)).toEqual([]);
    });
  });

  it("missing token: no MCP call, no attempt recorded", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv({ isolatedUrl: ISOLATED_ENDPOINT }, async () => {
      const recorder = recordFetch();
      let res;
      try {
        res = await t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        });
      } finally {
        recorder.restore();
      }
      expect(res.outcome).toBe("paused");
      expect(res.detail).toContain(ISOLATED_TOKEN_VAR);
      expect(res.attemptId).toBe(null);
      expect(recorder.calls).toEqual([]);
      expect(await attemptsIn(t)).toEqual([]);
    });
  });

  /**
   * The exact regression this work exists to prevent. Only the PRIVILEGED
   * variables are configured, so the old code would have used them.
   */
  it("dangerous fallback: only the PRIVILEGED pair configured -> still refuses", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv({ url: PRIVILEGED_ENDPOINT, token: PRIVILEGED_TOKEN }, async () => {
      const recorder = recordFetch();
      let res;
      try {
        res = await t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        });
      } finally {
        recorder.restore();
      }
      // The critical assertion: the privileged endpoint must never be reached.
      expect(res.outcome).toBe("paused");
      expect(res.detail).toContain(ISOLATED_ENDPOINT_VAR);
      expect(res.detail).not.toContain(PRIVILEGED_ENDPOINT);
      expect(res.detail).not.toContain(PRIVILEGED_TOKEN);
      // No transport was ever constructed, so no attempt row was written.
      expect(recorder.calls).toEqual([]);
      expect(await attemptsIn(t)).toEqual([]);
    });
  });

  it("privileged pair configured alongside the isolated pair: only the isolated one is called", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv(
      {
        url: PRIVILEGED_ENDPOINT,
        token: PRIVILEGED_TOKEN,
        isolatedUrl: ISOLATED_ENDPOINT,
        isolatedToken: ISOLATED_TOKEN,
      },
      async () => {
        const recorder = recordFetch();
        let res;
        try {
          res = await t.action(internal.dispatch.dispatchIssue, {
            ownerGrant: ownerGrantFor(grant),
            provider: PROVIDER,
            issueKey: ISSUE,
            projectId: PROJECT,
            message: "noop",
          });
        } finally {
          recorder.restore();
        }
        // Positive control: dispatch really tried to reach T3, so this asserts
        // the isolated pair is ACCEPTED, not that every configuration refuses.
        // (The stubbed fetch fails, so the launch is rejected and the attempt is
        // reconciled — which is the correct ambiguous outcome.)
        expect(res.outcome).toBe("ambiguous");
        expect(res.relaunchAuthorized).toBe(false);
        expect(recorder.calls.length).toBeGreaterThan(0);
        for (const call of recorder.calls) {
          expect(call.url).toBe(ISOLATED_ENDPOINT);
          expect(call.authorization).toBe(`Bearer ${ISOLATED_TOKEN}`);
        }
        expect(new Set(recorder.calls.map((c) => c.url))).toEqual(new Set([ISOLATED_ENDPOINT]));
      },
    );
  });

  it("invalid endpoint (not https): no MCP call, safe diagnostic", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv(
      { isolatedUrl: "http://isolated.example.invalid/mcp", isolatedToken: ISOLATED_TOKEN },
      async () => {
        const recorder = recordFetch();
        let res;
        try {
          res = await t.action(internal.dispatch.dispatchIssue, {
            ownerGrant: ownerGrantFor(grant),
            provider: PROVIDER,
            issueKey: ISSUE,
            projectId: PROJECT,
            message: "noop",
          });
        } finally {
          recorder.restore();
        }
        expect(res.outcome).toBe("paused");
        expect(res.detail).toContain(ISOLATED_ENDPOINT_VAR);
        // The invalid value itself is never echoed back.
        expect(res.detail).not.toContain("http://");
        expect(recorder.calls).toEqual([]);
        expect(await attemptsIn(t)).toEqual([]);
      },
    );
  });

  it("the credential gate still pauses after the owner gate passes", async () => {
    const t = convexTest(schema, modules);
    // An owner grant only: NO credential and NO isolated config. The owner gate
    // must pass so the CREDENTIAL gate is what trips.
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
    const grant = await t.mutation(internal.auth.grantOwner, {
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    const res = await t.action(internal.dispatch.dispatchIssue, {
      ownerGrant: ownerGrantFor(grant),
      provider: PROVIDER,
      issueKey: ISSUE,
      projectId: PROJECT,
      message: "noop",
    });
    expect(res.outcome).toBe("paused");
    expect(res.detail).toContain("no credential recorded");
    expect(res.attemptId).toBe(null);
  });

  it("reconciliation also fails closed when isolated config is missing", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);
    const seeded = await t.mutation(internal.launchAttempts.prepareLaunchAttempt, {
      issueKey: ISSUE,
      attemptId: "recon-missing-config",
    });
    const recorder = recordFetch();
    let res;
    try {
      res = await t.action(internal.dispatch.reconcileAttempt, {
        ownerGrant: ownerGrantFor(grant),
        attemptId: "recon-missing-config",
        projectId: PROJECT,
      });
    } finally {
      recorder.restore();
    }
    expect(res.state).toBe("config_blocked");
    expect(res.matchCount).toBe(0);
    expect(res.threadId).toBe(null);
    expect(res.relaunchAuthorized).toBe(false);
    expect(res.detail).toContain(ISOLATED_ENDPOINT_VAR);
    expect(res.correlationKey).toBe(seeded.correlationKey);
    expect(recorder.calls).toEqual([]);
    expect(await attemptsIn(t)).toHaveLength(1);
  });

  /**
   * Preserved behaviours. Both of these must survive the hardening untouched:
   * a failed launch is ambiguous, and ambiguity never authorizes a relaunch.
   */
  it("a rejected launch stays ambiguous, relaunches nothing, and is never settled", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);

    await withEnv({ isolatedUrl: ISOLATED_ENDPOINT, isolatedToken: ISOLATED_TOKEN }, async () => {
      const recorder = recordFetch();
      let res;
      try {
        res = await t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        });
      } finally {
        recorder.restore();
      }
      expect(res.outcome).toBe("ambiguous");
      expect(res.relaunchAuthorized).toBe(false);
      // The launch tool is attempted once; the only other call is the
      // reconciliation search. No second launch ever happens.
      expect(recorder.calls.length).toBeLessThanOrEqual(2);
      const rows = await attemptsIn(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("ambiguous");
      expect(rows[0]?.attemptId).toBe(res.attemptId);
    });
  });
});

describe("test-only fault injection controls stay internal", () => {
  it("declares the hooks as optional booleans on an internalAction", () => {
    // Both hooks must be optional booleans: an object-shaped hook arg could carry
    // arbitrary payload into the action, and a required one would break callers.
    expect(dispatchSource).toContain("forceAuthFailure: v.optional(v.boolean())");
    expect(dispatchSource).toContain("forceLostAck: v.optional(v.boolean())");
    // ... on an internalAction, which is the only reason they are unreachable.
    expect(dispatchSource).toMatch(/export const \w+ = internalAction\(\{/);
  });

  it("registers no public mutation/query/action that could forward them", () => {
    // The hooks are only safe while every entry point into this module is an
    // internalAction. A public `action({` here would expose them.
    const publicRegistrations = dispatchSource
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^export const \w+ = (mutation|query|action)\(/.test(line));
    expect(publicRegistrations).toEqual([]);
  });

  it("every dispatch export goes through the internal namespace only", () => {
    // No `api.` reference, which would bypass the internal boundary.
    expect(dispatchSource).not.toMatch(/\bapi\./);
    expect(dispatchSource).toContain("internal.credentials.canDispatch");
    expect(dispatchSource).toContain("internal.launchAttempts.prepareLaunchAttempt");
  });

  it("no path ever authorizes a relaunch", () => {
    expect(dispatchSource).not.toMatch(/relaunchAuthorized:\s*true/);
    // A relaunch path would be a second launch tool call.
    expect(dispatchSource.match(/t3_thread_launch/g)?.length).toBe(1);
  });
});

/**
 * INTEGRATION: EGA-677 + EGA-678 both landed on the same dispatch path.
 *
 * The two controls are independent. A valid owner grant must not excuse a
 * missing isolated credential pair, and a valid isolated pair must not excuse a
 * revoked owner grant. Neither gate may be satisfied in place of the other, and
 * neither may be reached after a remote call has already happened.
 */
describe("both gates are enforced, and neither substitutes for the other", () => {
  it("a valid owner grant does NOT excuse missing isolated credentials", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);
    await withEnv({}, async () => {
      const recorder = recordFetch();
      let res;
      try {
        res = await t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        });
      } finally {
        recorder.restore();
      }
      expect(res.outcome).toBe("paused");
      expect(res.detail).toContain(ISOLATED_ENDPOINT_VAR);
      expect(recorder.calls).toEqual([]);
      expect(await attemptsIn(t)).toEqual([]);
    });
  });

  it("a valid isolated credential pair does NOT excuse a revoked owner grant", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    await withEnv(
      { isolatedUrl: ISOLATED_ENDPOINT, isolatedToken: ISOLATED_TOKEN },
      async () => {
        const recorder = recordFetch();
        await expect(
          t.action(internal.dispatch.dispatchIssue, {
            ownerGrant: ownerGrantFor(grant),
            provider: PROVIDER,
            issueKey: ISSUE,
            projectId: PROJECT,
            message: "noop",
          }),
        ).rejects.toThrow(/unauthorized/i);
        recorder.restore();
        // The owner gate runs FIRST, so no remote call and no attempt row.
        expect(recorder.calls).toEqual([]);
        expect(await attemptsIn(t)).toEqual([]);
      },
    );
  });

  it("neither gate is reached after a remote call: the owner gate precedes the network", async () => {
    const t = convexTest(schema, modules);
    const grant = await seedActiveCredential(t);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    const recorder = recordFetch();
    try {
      await expect(
        t.action(internal.dispatch.dispatchIssue, {
          ownerGrant: ownerGrantFor(grant),
          provider: PROVIDER,
          issueKey: ISSUE,
          projectId: PROJECT,
          message: "noop",
        }),
      ).rejects.toThrow(/unauthorized/i);
    } finally {
      recorder.restore();
    }
    expect(recorder.calls).toEqual([]);
  });
});

describe("the privileged fallback is gone from the source", () => {
  it("no `?? process.env.T3_MCP_URL` or `?? process.env.T3_MCP_TOKEN` anywhere", () => {
    for (const src of codeLinesOf(dispatchSource).concat(codeLinesOf(configSource))) {
      expect(src).not.toMatch(/\?\?\s*process\.env\.T3_MCP_URL/);
      expect(src).not.toMatch(/\?\?\s*process\.env\.T3_MCP_TOKEN/);
    }
  });

  it("dispatch.ts reads no environment variable at all", () => {
    // Resolution moved into the helper; dispatch only consumes its result.
    const offenders = codeLinesOf(dispatchSource).filter((line) => /process\.env/.test(line));
    expect(offenders).toEqual([]);
  });

  it("the resolver reads only the two ISOLATED variables", () => {
    // The reads go through the exported constants, so assert on those: the
    // resolver must use the ISOLATED names and nothing else.
    const reads = configSource.match(/env\[\w+\]/g) ?? [];
    expect(new Set(reads)).toEqual(new Set(["env[ISOLATED_ENDPOINT_VAR]", "env[ISOLATED_TOKEN_VAR]"]));
    expect(ISOLATED_ENDPOINT_VAR).toBe("T3_MCP_URL_ISOLATED");
    expect(ISOLATED_TOKEN_VAR).toBe("T3_MCP_TOKEN_ISOLATED");
    expect(readFileSync(join(import.meta.dirname, "lib", "dispatchConfig.ts"), "utf8")).not.toMatch(
      /process\.env\.T3_MCP_(URL|TOKEN)(?![_A-Z])/,
    );
  });

  it("every isolated reference in dispatch.ts goes through the resolver", () => {
    expect(dispatchSource).toContain("resolveIsolatedDispatchConfig()");
    expect(dispatchSource).toContain("isolatedConfigDetail(");
    expect(dispatchSource).not.toContain("T3_MCP_URL_ISOLATED ??");
    expect(dispatchSource).not.toContain("T3_MCP_TOKEN_ISOLATED ??");
  });

  it("the resolver is reached before any MCP call on every path", () => {
    // Dispatch: resolution precedes prepareLaunchAttempt (nothing recorded).
    const dispatchHandler = dispatchSource.slice(
      dispatchSource.indexOf("export const dispatchIssue"),
      dispatchSource.indexOf("export const reconcileAttempt"),
    );
    expect(dispatchHandler.indexOf("resolveIsolatedDispatchConfig()")).toBeLessThan(
      dispatchHandler.indexOf("prepareLaunchAttempt"),
    );
    expect(dispatchHandler.indexOf("resolveIsolatedDispatchConfig()")).toBeLessThan(
      dispatchHandler.indexOf("t3_thread_launch"),
    );
    // Reconciliation: resolution precedes the only network call.
    const reconcileHandler = dispatchSource.slice(dispatchSource.indexOf("export const reconcileAttempt"));
    expect(reconcileHandler.indexOf("resolveIsolatedDispatchConfig()")).toBeLessThan(
      reconcileHandler.indexOf("findThreadsForCorrelation("),
    );
  });
});
