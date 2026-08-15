import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Stripe MCP connection for billing state.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration). Denied on
 * unattended factory runs: the server exposes money-moving writes (refunds,
 * subscription changes, payment links), which must never be reachable from a
 * prompt-injected labeled issue. Attended sessions are ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not touch Stripe.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "STRIPE_MCP_CONNECTOR",
      "stripe/acquisity-foreman-stripe"
    ),
    principalType: "app",
  }),
  description:
    "Stripe billing: customers, subscriptions, invoices, payments, refunds, and products.",
  url: "https://mcp.stripe.com",
});
