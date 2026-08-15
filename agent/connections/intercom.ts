import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * App-scoped via Vercel Connect. Denied on unattended factory runs:
 * conversations carry customer PII and the server can reply to users.
 * Attended sessions are ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not read Intercom.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv("INTERCOM_MCP_CONNECTOR", "intercom/foreman"),
    principalType: "app",
  }),
  description:
    "Intercom customer support: conversations, contacts, companies, and help center articles.",
  url: "https://mcp.intercom.com/mcp",
});
