import { requireEnv } from "./constants.js";
import { managedConnect } from "./managed-connect.js";

/**
 * The one Raindrop credential: the api-key connector the MCP connection
 * uses. Authored tools and the connection share it rather than holding a
 * second connector.
 */
export const raindropAuth = managedConnect({
  connector: requireEnv(
    "RAINDROP_MCP_CONNECTOR",
    "api.raindrop.ai/acquisity-foreman-raindrop"
  ),
  principalType: "app",
});
