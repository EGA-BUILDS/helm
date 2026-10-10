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
    prevIssuer = process.env.CLERK_ISSUER_DOMAIN;
    process.env.HELM_OWNER_SUBJECT = OWNER_SUBJECT;
    process.env.CLERK_ISSUER_DOMAIN = OWNER_ISSUER;
  });

  afterEach(() => {
    if (prevOwner === undefined) delete process.env.HELM_OWNER_SUBJECT;
    else process.env.HELM_OWNER_SUBJECT = prevOwner;
    if (prevIssuer === undefined) delete process.env.CLERK_ISSUER_DOMAIN;
    else process.env.CLERK_ISSUER_DOMAIN = prevIssuer;
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
