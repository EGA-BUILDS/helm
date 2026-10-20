import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionAccessChoice } from "./ConnectionAccessChoice";

describe("ConnectionAccessChoice", () => {
  it("renders read-only and operate choices", () => {
    const html = renderToStaticMarkup(createElement(ConnectionAccessChoice, { value: "read-only", onChange: () => {} }));
    expect(html).toContain("Read only");
    expect(html).toContain("Operate");
    expect(html).toContain("Widens access");
    expect(html).toContain("T3 will show its own consent screen");
  });
});