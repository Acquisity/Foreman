import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * Jam MCP connection for bug report context.
 *
 * @remarks
 * App-scoped via Vercel Connect (OAuth registration against Jam's hosted
 * server). Denied on unattended factory runs; attended sessions are ungated.
 * Jam recordings carry user data (console logs, network traces), so access
 * stays behind a human.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not read Jam recordings.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "JAM_MCP_CONNECTOR",
      "mcp.jam.dev/acquisity-foreman-jam"
    ),
    principalType: "app",
  }),
  description:
    "Jam bug reports: recordings, console logs, network traces, and reproduction details.",
  url: "https://mcp.jam.dev/mcp",
});
