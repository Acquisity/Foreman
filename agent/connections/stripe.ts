import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Stripe MCP connection for billing investigation.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration); tokens are
 * minted per call and never exposed to the model. Available to every
 * session, unattended runs included — the intended posture is read-only
 * evidence gathering. TODO(read-only filter): once the connector is
 * authorized, list the server's tools and allowlist the read-only surface
 * (money-moving writes such as refunds and payment links must be excluded).
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
    "Stripe billing: customers, subscriptions, invoices, payments, refunds, disputes, and products.",
  url: "https://mcp.stripe.com",
});
