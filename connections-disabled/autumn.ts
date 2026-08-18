import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../agent/lib/constants.js";

/**
 * Autumn MCP connection for billing/plan/entitlement investigation.
 *
 * @remarks
 * App-scoped via Vercel Connect; tokens are minted per call and never
 * exposed to the model. Read-only by tool allowlist: only the customer
 * and subscription read tools are allowed; write/mutation tools are
 * excluded so billing changes are unreachable.
 *
 * NOTE: the exact read-only tool names for the Autumn MCP server are not
 * verified. The allowlist below uses reasonable defaults and should be
 * confirmed against the server's live tool list when this connection is
 * wired up.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "AUTUMN_MCP_CONNECTOR",
      "mcp.useautumn.com/acquisity-foreman-autumn"
    ),
    principalType: "app",
  }),
  description:
    "Autumn billing, read-only: customer plans, add-ons, feature and credit balances, and subscription state.",
  tools: {
    allow: [
      "get_customer",
      "list_customers",
      "get_subscription",
      "list_subscriptions",
    ],
  },
  url: "https://mcp.useautumn.com/mcp",
});
