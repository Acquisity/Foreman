import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Axiom MCP connection for production log queries.
 *
 * @remarks
 * App-scoped via Vercel Connect (OAuth registration against Axiom's hosted
 * server). Denied on unattended factory runs until the server's tool surface
 * is confirmed read-only (it may expose monitor/dataset writes); attended
 * sessions are ungated.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not query Axiom.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "AXIOM_MCP_CONNECTOR",
      "mcp.axiom.co/acquisity-foreman-axiom"
    ),
    principalType: "app",
  }),
  description:
    "Axiom observability: datasets and APL queries over production structured logs.",
  url: "https://mcp.axiom.co/mcp",
});
