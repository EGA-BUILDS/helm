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
import type * as execution from "../execution.js";
import type * as health from "../health.js";
import type * as integration__verifyProbe from "../integration/_verifyProbe.js";
import type * as integration_linearGraphql from "../integration/linearGraphql.js";
import type * as integration_linearVerification from "../integration/linearVerification.js";
import type * as integration_reachability from "../integration/reachability.js";
import type * as integration_setup from "../integration/setup.js";
import type * as integration_t3Discovery from "../integration/t3Discovery.js";
import type * as integration_t3Mcp from "../integration/t3Mcp.js";
import type * as launchAttempts from "../launchAttempts.js";
import type * as lib_acceptanceCriteria from "../lib/acceptanceCriteria.js";
import type * as lib_attemptRecovery from "../lib/attemptRecovery.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_dispatchConfig from "../lib/dispatchConfig.js";
import type * as lib_dispatchConfigValidation from "../lib/dispatchConfigValidation.js";
import type * as lib_interruptErrors from "../lib/interruptErrors.js";
import type * as lib_latestAttempt from "../lib/latestAttempt.js";
import type * as lib_launchErrors from "../lib/launchErrors.js";
import type * as lib_linearGraphql from "../lib/linearGraphql.js";
import type * as lib_linearHelpers from "../lib/linearHelpers.js";
import type * as lib_linearIssues from "../lib/linearIssues.js";
import type * as lib_operateGate from "../lib/operateGate.js";
import type * as lib_runStatus from "../lib/runStatus.js";
import type * as lib_sendErrors from "../lib/sendErrors.js";
import type * as lib_t3EndpointPolicy from "../lib/t3EndpointPolicy.js";
import type * as lib_t3PinnedLookup from "../lib/t3PinnedLookup.js";
import type * as lib_threadIdentity from "../lib/threadIdentity.js";
import type * as lib_verifiedPullRequest from "../lib/verifiedPullRequest.js";
import type * as linearConnectionsStore from "../linearConnectionsStore.js";
import type * as linearIssues from "../linearIssues.js";
import type * as linearOAuth from "../linearOAuth.js";
import type * as projectMappings from "../projectMappings.js";
import type * as projectMappingsStore from "../projectMappingsStore.js";
import type * as t3Attention from "../t3Attention.js";
import type * as t3ConnectionsStore from "../t3ConnectionsStore.js";
import type * as t3Interrupt from "../t3Interrupt.js";
import type * as t3Launch from "../t3Launch.js";
import type * as t3OAuth from "../t3OAuth.js";
import type * as t3Send from "../t3Send.js";
import type * as verifiedPullRequest from "../verifiedPullRequest.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  credentials: typeof credentials;
  dispatch: typeof dispatch;
  execution: typeof execution;
  health: typeof health;
  "integration/_verifyProbe": typeof integration__verifyProbe;
  "integration/linearGraphql": typeof integration_linearGraphql;
  "integration/linearVerification": typeof integration_linearVerification;
  "integration/reachability": typeof integration_reachability;
  "integration/setup": typeof integration_setup;
  "integration/t3Discovery": typeof integration_t3Discovery;
  "integration/t3Mcp": typeof integration_t3Mcp;
  launchAttempts: typeof launchAttempts;
  "lib/acceptanceCriteria": typeof lib_acceptanceCriteria;
  "lib/attemptRecovery": typeof lib_attemptRecovery;
  "lib/auth": typeof lib_auth;
  "lib/dispatchConfig": typeof lib_dispatchConfig;
  "lib/dispatchConfigValidation": typeof lib_dispatchConfigValidation;
  "lib/interruptErrors": typeof lib_interruptErrors;
  "lib/latestAttempt": typeof lib_latestAttempt;
  "lib/launchErrors": typeof lib_launchErrors;
  "lib/linearGraphql": typeof lib_linearGraphql;
  "lib/linearHelpers": typeof lib_linearHelpers;
  "lib/linearIssues": typeof lib_linearIssues;
  "lib/operateGate": typeof lib_operateGate;
  "lib/runStatus": typeof lib_runStatus;
  "lib/sendErrors": typeof lib_sendErrors;
  "lib/t3EndpointPolicy": typeof lib_t3EndpointPolicy;
  "lib/t3PinnedLookup": typeof lib_t3PinnedLookup;
  "lib/threadIdentity": typeof lib_threadIdentity;
  "lib/verifiedPullRequest": typeof lib_verifiedPullRequest;
  linearConnectionsStore: typeof linearConnectionsStore;
  linearIssues: typeof linearIssues;
  linearOAuth: typeof linearOAuth;
  projectMappings: typeof projectMappings;
  projectMappingsStore: typeof projectMappingsStore;
  t3Attention: typeof t3Attention;
  t3ConnectionsStore: typeof t3ConnectionsStore;
  t3Interrupt: typeof t3Interrupt;
  t3Launch: typeof t3Launch;
  t3OAuth: typeof t3OAuth;
  t3Send: typeof t3Send;
  verifiedPullRequest: typeof verifiedPullRequest;
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
