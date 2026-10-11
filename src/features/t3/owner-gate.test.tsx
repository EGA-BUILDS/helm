import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUseUser, mockUseConvexAuth, mockUseQuery } = vi.hoisted(() => ({
  mockUseUser: vi.fn(),
  mockUseConvexAuth: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  SignIn: () => createElement("span", null, "Clerk sign-in form"),
  SignOutButton: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  UserButton: () => createElement("span", null, "Account controls"),
  useUser: mockUseUser,
}));
vi.mock("convex/react", () => ({ useConvexAuth: mockUseConvexAuth, useQuery: mockUseQuery }));
vi.mock("../../app/ConvexHealthStatus", () => ({ ConvexHealthStatus: () => createElement("span", null, "Convex health") }));

import { OwnerDashboard } from "../../app/OwnerDashboard";

afterEach(() => vi.clearAllMocks());

describe("existing Clerk and owner presentation remains gated", () => {
  it("shows Clerk sign-in without rendering private dashboard content when signed out", () => {
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: false });

    const html = renderToStaticMarkup(createElement(OwnerDashboard));

    expect(html).toContain("Sign in to Helm");
    expect(html).toContain("Clerk sign-in form");
    expect(html).not.toContain("Everything in view");
  });

  it("shows the dashboard and account controls only after owner verification", () => {
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true });
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true });
    mockUseQuery.mockReturnValue({ owner: true });

    const html = renderToStaticMarkup(createElement(OwnerDashboard));

    expect(html).toContain("Everything in view");
    expect(html).toContain("Account controls");
    expect(html).toContain("T3 backend integration is not available yet");
    expect(html).not.toContain("fixture-scenario");
  });
});
