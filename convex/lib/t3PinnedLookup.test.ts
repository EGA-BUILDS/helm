import { describe, expect, it } from "vitest";
import { pinnedIpv4Lookup } from "./t3PinnedLookup";

describe("pinned IPv4 DNS callback", () => {
  for (const all of [true, false]) {
    it(`uses the correct callback shape for all=${all}`, async () => {
      const result = await new Promise<unknown>((resolve, reject) => {
        pinnedIpv4Lookup("8.8.8.8")(
          "example.test",
          { all },
          (error, address, family) => {
            if (error) reject(error);
            else resolve({ address, family });
          },
        );
      });

      expect(result).toEqual({
        address: all
          ? [{ address: "8.8.8.8", family: 4 }]
          : "8.8.8.8",
        family: all ? undefined : 4,
      });
    });
  }
});
