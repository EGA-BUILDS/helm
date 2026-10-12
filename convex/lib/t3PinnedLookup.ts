import type { LookupFunction } from "node:net";

export function pinnedIpv4Lookup(address: string): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family: 4 }]);
    } else {
      callback(null, address, 4);
    }
  };
}
