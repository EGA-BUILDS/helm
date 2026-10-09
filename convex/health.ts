import { v } from "convex/values";
import { query } from "./_generated/server";

export const check = query({
  args: {},
  returns: v.object({
    status: v.literal("ok"),
  }),
  handler: async () => ({ status: "ok" as const }),
});
