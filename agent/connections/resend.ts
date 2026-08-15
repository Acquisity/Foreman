import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Resend MCP connection for transactional email state.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration). Denied on
 * unattended factory runs: the server can send email, which must never be
 * reachable from a prompt-injected labeled issue. Attended sessions are
 * ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not send or read email.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "RESEND_MCP_CONNECTOR",
      "resend/acquisity-foreman-resend"
    ),
    principalType: "app",
  }),
  description:
    "Resend email: domains, API keys, audiences, broadcasts, and email delivery status.",
  url: "https://mcp.resend.com/mcp",
});
