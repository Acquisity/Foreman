import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Sentry MCP connection for production error tracking.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration). Denied on
 * unattended factory runs because the server also exposes writes (resolving
 * and assigning issues, creating projects); attended sessions are ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not use Sentry.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "SENTRY_MCP_CONNECTOR",
      "sentry/acquisity-foreman-sentry"
    ),
    principalType: "app",
  }),
  description:
    "Sentry error tracking: issues, events, stack traces, releases, and projects for production errors.",
  url: "https://mcp.sentry.dev/mcp",
});
