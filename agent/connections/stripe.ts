import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Stripe MCP connection for billing investigation.
 *
 * @remarks
 * User-scoped via Vercel Connect (MCP automatic registration); uses the
 * authorization-code grant: a one-time consent stores a refresh token,
 * after which calls are non-interactive and auto-refreshing, and tokens are
 * never exposed to the model. Configured intake-only channels use the
 * separate restricted-key root tool so they do not depend on the requester's
 * OAuth grant. Read-only by tool allowlist, built
 * from the server's live tool list: `stripe_api_read` / `stripe_api_search`
 * cover the read API surface; `stripe_api_write` and account management are
 * excluded so money-moving operations are unreachable.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "STRIPE_MCP_CONNECTOR",
      "stripe/acquisity-foreman-stripe"
    ),
    principalType: "user",
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
