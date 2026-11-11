import { ConnectionAuthorizationFailedError } from "eve/connections";
import { managedConnect } from "../managed-connect.js";
import {
  DISPUTES_TOOLKIT,
  type ExecutorToolkit,
  FOREMAN_TOOLKIT_SLUG,
  SUPPORT_TOOLKIT,
} from "./endpoint.js";

// One app-principal Vercel Connect API-key connector per lane, each holding the
// personal access token of that lane's Executor v2 bot user. A bot reaches only
// the apps shared with its group, so a lane never uses another lane's connector.
const CONNECTOR_ENV = {
  [DISPUTES_TOOLKIT]: "EXECUTOR_MCP_CONNECTOR_DISPUTES",
  [FOREMAN_TOOLKIT_SLUG]: "EXECUTOR_MCP_CONNECTOR_FOREMAN",
  [SUPPORT_TOOLKIT]: "EXECUTOR_MCP_CONNECTOR_SUPPORT",
} as const satisfies Record<ExecutorToolkit, string>;
const lanes = new WeakMap<object, ExecutorToolkit>();

/** The lane's own connector UID, or undefined when it is not configured. */
export function laneConnector(lane: ExecutorToolkit): string | undefined {
  if (!Object.hasOwn(CONNECTOR_ENV, lane)) {
    throw new Error("Unknown Foreman toolkit.");
  }
  return process.env[CONNECTOR_ENV[lane]] || undefined;
}

/** The connectors are provisioned and attached separately, before cutover. */
export function executorAuth(lane: ExecutorToolkit = FOREMAN_TOOLKIT_SLUG) {
  const connector = laneConnector(lane);
  if (!connector) {
    throw new ConnectionAuthorizationFailedError("executor", {
      message:
        "Executor is not configured for Foreman. This source is unavailable; do not retry or request provider sign-in.",
      reason: "executor_not_configured",
      retryable: false,
    });
  }
  const auth = managedConnect({ connector, principalType: "app" });
  lanes.set(auth, lane);
  return auth;
}

/** The lane an {@link executorAuth} definition was made for. */
export const authLane = (auth: unknown): ExecutorToolkit | undefined =>
  typeof auth === "object" && auth !== null ? lanes.get(auth) : undefined;
