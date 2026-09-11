import { managedConnect } from "./managed-connect.js";
import { parseIntakeOnlyChannels } from "./slack-intake.js";

/**
 * Reads a required environment variable, throwing if it is unset so
 * misconfiguration fails fast instead of surfacing mid-request.
 *
 * @remarks
 * Call it at module load when the value is needed for discovery (connector
 * UIDs, channel credentials), or inside a handler when a missing value
 * should not prevent the rest of the agent from loading.
 *
 * @param name - The environment variable name.
 * @param example - An example value, included in the error message.
 * @returns The environment variable's value.
 */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is not set (e.g. '${example}').`
    );
  }
  return value;
}

const REVIEW_BOT_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}(?:\[bot\])?$/;

export const FOREMAN_REVIEW_BOT_LOGINS = new Set(
  (process.env.FOREMAN_REVIEW_BOT_LOGINS ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => REVIEW_BOT_LOGIN_PATTERN.test(login))
);

// Slack channel IDs where mentions are intake-only: work items are routed to
// Linear instead of publishing code. Unset means no intake-only
// channels.
export const SLACK_INTAKE_ONLY_CHANNELS = parseIntakeOnlyChannels(
  process.env.SLACK_INTAKE_ONLY_CHANNELS
);

/** Acquisity's Slack workspace, and the owner within it. */
export const SLACK_TEAM_ID = "T0A9AUZJXC2";
export const OWNER_USER_ID = "U0BBHB86PUY";

/** Linear channel attachment downloads keep the existing app installation. */
export const linearAuth = managedConnect({
  connector: requireEnv("LINEAR_CONNECTOR", "linear/foreman-agent"),
  principalType: "app",
  tokenParams: {
    scopes: ["read", "write", "issues:create", "comments:create"],
  },
});
