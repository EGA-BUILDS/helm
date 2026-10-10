/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * EGA-678 F1 owner-authorization tests.
 *
 * All identities are local mocks through `convexTest(...).withIdentity(...)`;
 * no real Clerk login, live Convex auth, or browser flow is exercised here.
 * Placeholders only — never a real subject, issuer, or secret.
 *
 * Contract under test: `requireOwner` admits only a verified identity whose
 * issuer AND immutable subject match server configuration, backed by an
 * explicit active grant row. Everything else fails closed with
 * `unauthorized`.
 */
const OWNER_SUBJECT = "owner-subject-placeholder";
const OWNER_ISSUER = "https://test-issuer-placeholder.clerk.accounts.dev";
const OWNER_IDENTITY = {
  tokenIdentifier: `${OWNER_ISSUER}|${OWNER_SUBJECT}`,
  subject: OWNER_SUBJECT,
  issuer: OWNER_ISSUER,
};

const modules = import.meta.glob("./**/*.ts");

function grantOwner(t: ReturnType<typeof convexTest>) {
  return t.mutation(internal.auth.grantOwner, {
    subject: OWNER_SUBJECT,
    issuer: OWNER_ISSUER,
  });
}

describe("owner authorization", () => {
  let prevOwner: string | undefined;
  let prevIssuer: string | undefined;

  beforeEach(() => {
    prevOwner = process.env.HELM_OWNER_SUBJECT;
    prevIssuer = process.env.CLERK_FRONTEND_API_URL;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  });

  afterEach(() => {
    if (prevOwner === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = prevOwner;
    if (prevIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = prevIssuer;
  });

  it("denies unauthenticated access (no identity)", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("denies an authenticated non-owner, even with an arbitrary valid id", async () => {
    const t = convexTest(schema, modules);
    await grantOwner(t);
    const impostor = t.withIdentity({
      tokenIdentifier: `${OWNER_ISSUER}|arbitrary-resource-id`,
      subject: "arbitrary-resource-id",
      issuer: OWNER_ISSUER,
    });
    await expect(impostor.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("denies the owner subject from an untrusted issuer", async () => {
    const t = convexTest(schema, modules);
    await grantOwner(t);
    const forged = t.withIdentity({
      tokenIdentifier: `https://evil-issuer.example.com|${OWNER_SUBJECT}`,
      subject: OWNER_SUBJECT,
      issuer: "https://evil-issuer.example.com",
    });
    await expect(forged.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("denies a mismatched token identifier even when subject and issuer match", async () => {
    const t = convexTest(schema, modules);
    await grantOwner(t);
    const mismatched = t.withIdentity({
      tokenIdentifier: `${OWNER_ISSUER}|some-other-subject`,
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    await expect(mismatched.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("denies the owner without an explicit active grant", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("denies access when the owner grant was revoked", async () => {
    const t = convexTest(schema, modules);
    await grantOwner(t);
    const revoked = await t.mutation(internal.auth.revokeOwner, {
      subject: OWNER_SUBJECT,
    });
    expect(revoked.revoked).toBe(true);
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("authorizes the owner once an explicit grant exists", async () => {
    const t = convexTest(schema, modules);
    const granted = await grantOwner(t);
    expect(granted.revision).toBe(1);
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).resolves.toEqual({
      authorized: true,
      application: "helm",
      session: "owner",
    });
  });

  it("bumps the revision on rotation and reports it to scheduled checks", async () => {
    const t = convexTest(schema, modules);
    await grantOwner(t);
    const rotated = await grantOwner(t);
    expect(rotated.revision).toBe(2);
    const revision = await t.query(internal.auth.activeGrantRevision, {
      subject: OWNER_SUBJECT,
      issuer: OWNER_ISSUER,
    });
    expect(revision).toBe(2);
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).resolves.toBeDefined();
  });

  it("reports no active revision after revocation (scheduled-action guard)", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.query(internal.auth.activeGrantRevision, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
      }),
    ).toBe(null);
    await grantOwner(t);
    await t.mutation(internal.auth.revokeOwner, { subject: OWNER_SUBJECT });
    expect(
      await t.query(internal.auth.activeGrantRevision, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
      }),
    ).toBe(null);
  });

  it("refuses background work authorized under a stale grant revision", async () => {
    const t = convexTest(schema, modules);
    const first = await grantOwner(t);
    await grantOwner(t); // rotation supersedes revision 1
    await expect(
      t.query(internal.auth.assertCurrentGrant, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
        revision: first.revision,
      }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      t.query(internal.auth.assertCurrentGrant, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
        revision: first.revision + 1,
      }),
    ).resolves.toBe(true);
  });

  it("denies everything when the owner identity is not configured", async () => {
    delete process.env.HELM_OWNER_SUBJECT;
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).rejects.toThrow(
      /unauthorized/,
    );
  });
});

/**
 * Single-owner-invariant safety under a duplicated grant ledger.
 *
 * Convex generates the document id, so `grantOwner` cannot be made an idempotent
 * "insert if absent". Two concurrent cold-start bootstrap calls can therefore
 * both observe "no row" and both insert. The invariant that matters is that a
 * duplicate can NEVER grant a second owner or widen authority, and that it can
 * never surface as an opaque crash. These tests pin that behaviour.
 */
describe("single-owner invariant under a duplicated grant ledger", () => {
  let savedSubject: string | undefined;
  let savedIssuer: string | undefined;

  beforeEach(() => {
    savedSubject = process.env.HELM_OWNER_SUBJECT;
    savedIssuer = process.env.CLERK_FRONTEND_API_URL;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_FRONTEND_API_URL = OWNER_ISSUER;
  });

  afterEach(() => {
    if (savedSubject === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = savedSubject;
    if (savedIssuer === undefined) delete process.env.CLERK_FRONTEND_API_URL;
    else process.env.CLERK_FRONTEND_API_URL = savedIssuer;
  });

  /** Force the duplicate-row state a concurrent double bootstrap would produce. */
  async function forceDuplicateLedger(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("ownerGrants", {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
        grantedAt: 1,
        revokedAt: null,
        revision: 1,
      });
      await ctx.db.insert("ownerGrants", {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
        grantedAt: 2,
        revokedAt: null,
        revision: 2,
      });
    });
  }

  it("DENIES owner access when the ledger is ambiguous, with an unauthorized error", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    const owner = t.withIdentity(OWNER_IDENTITY);
    // The failure is an authorization denial, not an opaque crash.
    await expect(owner.query(api.auth.session, {})).rejects.toThrow(/unauthorized/);
    await expect(owner.query(api.auth.session, {})).rejects.toThrow(/ambiguous/);
  });

  it("DENIES background work when the ledger is ambiguous", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    await expect(
      t.query(internal.auth.assertCurrentGrant, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
        revision: 2,
      }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      t.query(internal.auth.activeGrantRevision, {
        subject: OWNER_SUBJECT,
        issuer: OWNER_ISSUER,
      }),
    ).resolves.toBe(null);
  });

  it("a duplicate ledger grants NO authority that did not already exist", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    // Neither revision is accepted; the duplicate cannot widen authority.
    for (const revision of [1, 2]) {
      await expect(
        t.query(internal.auth.assertCurrentGrant, {
          subject: OWNER_SUBJECT,
          issuer: OWNER_ISSUER,
          revision,
        }),
      ).rejects.toThrow(/unauthorized/);
    }
  });

  it("repairOwnerGrants collapses duplicates to one deterministic survivor", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    const result = await t.mutation(internal.auth.repairOwnerGrants, {
      subject: OWNER_SUBJECT,
    });
    expect(result.repaired).toBe(true);
    // The highest revision survives by an explicit rule, not index order.
    expect(result.survivingRevision).toBe(2);
    expect(result.removed).toBe(1);

    // Authority is restored and unambiguous again.
    const owner = t.withIdentity(OWNER_IDENTITY);
    await expect(owner.query(api.auth.session, {})).resolves.toMatchObject({
      authorized: true,
    });
  });

  it("repair is a no-op on a healthy single-row ledger", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER });
    const result = await t.mutation(internal.auth.repairOwnerGrants, {
      subject: OWNER_SUBJECT,
    });
    expect(result.repaired).toBe(false);
    expect(result.survivingRevision).toBe(1);
    expect(result.removed).toBe(0);
  });

  it("repair refuses a subject that is not the configured owner", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    await expect(
      t.mutation(internal.auth.repairOwnerGrants, { subject: "someone-else" }),
    ).rejects.toThrow(/unconfigured owner subject/);
  });

  it("grantOwner after a duplicate ledger does not create a third row", async () => {
    const t = convexTest(schema, modules);
    await forceDuplicateLedger(t);
    // Reads deny, so grantOwner cannot even select a survivor to patch.
    await expect(
      t.mutation(internal.auth.grantOwner, { subject: OWNER_SUBJECT, issuer: OWNER_ISSUER }),
    ).rejects.toThrow(/unauthorized|ambiguous/);
    const rows = await t.run(async (ctx) => await ctx.db.query("ownerGrants").collect());
    expect(rows).toHaveLength(2);
  });
});
