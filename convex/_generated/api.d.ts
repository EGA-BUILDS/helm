/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as credentials from "../credentials.js";
import type * as dispatch from "../dispatch.js";
import type * as health from "../health.js";
import type * as integration__verifyProbe from "../integration/_verifyProbe.js";
import type * as integration_linearGraphql from "../integration/linearGraphql.js";
import type * as integration_linearVerification from "../integration/linearVerification.js";
import type * as integration_reachability from "../integration/reachability.js";
import type * as integration_setup from "../integration/setup.js";
import type * as integration_t3Discovery from "../integration/t3Discovery.js";
import type * as integration_t3Mcp from "../integration/t3Mcp.js";
import type * as launchAttempts from "../launchAttempts.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  credentials: typeof credentials;
  dispatch: typeof dispatch;
  health: typeof health;
  "integration/_verifyProbe": typeof integration__verifyProbe;
  "integration/linearGraphql": typeof integration_linearGraphql;
  "integration/linearVerification": typeof integration_linearVerification;
  "integration/reachability": typeof integration_reachability;
  "integration/setup": typeof integration_setup;
  "integration/t3Discovery": typeof integration_t3Discovery;
  "integration/t3Mcp": typeof integration_t3Mcp;
  launchAttempts: typeof launchAttempts;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
