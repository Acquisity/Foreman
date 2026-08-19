import { connect } from "@vercel/connect/eve";

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

/**
 * The GitHub label that hands an issue to the factory. Overridable with the
 * `FOREMAN_FACTORY_LABEL` environment variable.
 *
 * @remarks
 * Applying it requires triage permission on the repository, so the trigger is
 * maintainer-initiated even though the resulting run is unattended.
 */
export const FOREMAN_FACTORY_LABEL =
  process.env.FOREMAN_FACTORY_LABEL ?? "factory";

/**
 * Branch-name prefix for the factory's own feature branches. Overridable
 * with the `FOREMAN_BRANCH_PREFIX` environment variable.
 *
 * @remarks
 * The implementer uses this prefix; the GitHub
 * channel uses the prefix to recognize the factory's own pull requests, so
 * the red-CI fix loop never runs on branches people pushed. The implementer's
 * instructions carry the default prefix as prose, so an override should keep
 * them in sync (`agent/subagents/implementer/instructions.md`).
 */
export const FOREMAN_BRANCH_PREFIX =
  process.env.FOREMAN_BRANCH_PREFIX ?? "foreman/";

if (
  !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(FOREMAN_BRANCH_PREFIX) ||
  FOREMAN_BRANCH_PREFIX.slice(0, -1)
    .split("/")
    .some((part) => part === "" || part === "." || part === "..")
) {
  throw new Error(
    "FOREMAN_BRANCH_PREFIX must be a safe branch prefix ending in '/'."
  );
}

const REVIEW_BOT_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}(?:\[bot\])?$/;

export const FOREMAN_REVIEW_BOT_LOGINS = new Set(
  (process.env.FOREMAN_REVIEW_BOT_LOGINS ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => REVIEW_BOT_LOGIN_PATTERN.test(login))
);

/**
 * Shared Linear authorization via Vercel Connect.
 *
 * Single source of truth for the Linear connector so every consumer — the
 * Linear MCP connection and any tool calling the GraphQL API directly —
 * shares one Linear installation and one set of scopes.
 *
 * @remarks
 * - App-scoped (`principalType: "app"`), so no per-user consent flow is
 *   required; tokens are minted for the installation itself.
 * - Tokens are requested per call via `ctx.getToken(linearAuth)`, cached per
 *   step by eve, and never exposed to the model.
 * - The connector UID comes from the `LINEAR_CONNECTOR` environment variable
 *   (e.g. `linear/foreman-agent`); the module throws at load time if it
 *   is not set.
 *
 * @example
 * ```ts
 * const { token } = await ctx.getToken(linearAuth);
 * ```
 */
export const linearAuth = connect({
  connector: requireEnv("LINEAR_CONNECTOR", "linear/foreman-agent"),
  principalType: "app",
  tokenParams: {
    scopes: ["read", "write", "issues:create", "comments:create"],
  },
});
