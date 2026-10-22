import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionAccessChoice } from "./ConnectionAccessChoice";

function render(value: "read-only" | "operate") {
  return renderToStaticMarkup(createElement(ConnectionAccessChoice, { value, onChange: () => {} }));
}

describe("ConnectionAccessChoice", () => {
  it("renders read-only and operate choices", () => {
    const html = render("read-only");
    expect(html).toContain("Read only");
    expect(html).toContain("Operate");
    expect(html).toContain("Widens access");
  });

  it("tells the owner to choose Read only for a read-only connection", () => {
    const html = render("read-only");
    expect(html).toContain("choose Read only");
    expect(html).toContain("Helm will reject any broader permission level");
    expect(html).not.toContain("choose Supervised (recommended)");
  });

  it("tells the owner to choose Supervised for an operate connection", () => {
    const html = render("operate");
    expect(html).toContain("choose Supervised (recommended)");
    expect(html).toContain("Auto-accept edits and Auto also grant the required OAuth permissions");
    expect(html).toContain("Do not choose Read only or Full access");
    expect(html).toContain("Full access also grants settings and source-control permissions");
  });

  it("explains that T3 decides the grant and Helm verifies it exactly", () => {
    const html = render("operate");
    expect(html).toContain("T3 decides which permissions to grant");
    expect(html).toContain("exactly match the selected access level");
  });
});
