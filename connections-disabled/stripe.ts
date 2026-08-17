import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../agent/lib/constants.js";

/**
 * Stripe MCP connection for billing investigation.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration); tokens are
 * minted per call and never exposed to the model. Available to every
 * session, unattended runs included. Read-only by tool allowlist, built
 * from the server's live tool list: `stripe_api_read` / `stripe_api_search`
 * cover the read API surface; `stripe_api_write` and account management are
 * excluded so money-moving operations are unreachable.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "STRIPE_MCP_CONNECTOR",
      "stripe/acquisity-foreman-stripe"
    ),
    principalType: "app",
  }),
  description:
    "Stripe billing, read-only: customers, subscriptions, invoices, payments, refunds, disputes, products, and Stripe documentation search.",
  tools: {
    allow: [
      "get_stripe_account_info",
      "list_available_accounts_or_orgs",
      "search_stripe_documentation",
      "stripe_api_details",
      "stripe_api_read",
      "stripe_api_search",
      "stripe_implementation_planner",
    ],
  },
  url: "https://mcp.stripe.com",
});
