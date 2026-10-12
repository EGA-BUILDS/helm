/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
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
import type * as lib_auth from "../lib/auth.js";
import type * as lib_dispatchConfig from "../lib/dispatchConfig.js";
import type * as lib_dispatchConfigValidation from "../lib/dispatchConfigValidation.js";
import type * as lib_threadIdentity from "../lib/threadIdentity.js";
import type * as t3ConnectionsStore from "../t3ConnectionsStore.js";
import type * as t3OAuth from "../t3OAuth.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
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
  "lib/auth": typeof lib_auth;
  "lib/dispatchConfig": typeof lib_dispatchConfig;
  "lib/dispatchConfigValidation": typeof lib_dispatchConfigValidation;
  "lib/threadIdentity": typeof lib_threadIdentity;
  t3ConnectionsStore: typeof t3ConnectionsStore;
  t3OAuth: typeof t3OAuth;
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
