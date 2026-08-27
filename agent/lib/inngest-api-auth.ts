import { requireEnv } from "./constants.js";
import { managedConnect } from "./managed-connect.js";

/**
 * The one Inngest credential: the API-key connector the MCP connection
 * already uses. The same key serves Inngest's REST API, so authored tools
 * and the connection share it rather than holding a second connector.
 */
export const inngestAuth = managedConnect({
  connector: requireEnv(
    "INNGEST_MCP_CONNECTOR",
    "api.inngest.com/acquisity-foreman-inngest"
  ),
  principalType: "app",
});
