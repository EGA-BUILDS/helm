import { defineSchema } from "convex/server";

/**
 * Application schema. Empty for EGA-676 (only the no-data `health` function
 * exists). Feature issues add their own tables/indexes here (project, issues,
 * snapshots, attempts, commands, slot, observations, notes, history).
 */
export default defineSchema({});
