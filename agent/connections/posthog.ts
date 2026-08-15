import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * PostHog MCP connection for product analytics.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration). Denied on
 * unattended factory runs because the server exposes writes (feature flags,
 * insights, annotations); attended sessions are ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not use PostHog.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "POSTHOG_MCP_CONNECTOR",
      "posthog/acquisity-foreman-posthog"
    ),
    principalType: "app",
  }),
  description:
    "PostHog product analytics: events, insights, funnels, feature flags, and experiments.",
  url: "https://mcp.posthog.com/mcp",
});
