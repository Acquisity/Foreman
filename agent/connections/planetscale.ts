import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * PlanetScale MCP connection for database state and query insights.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration). Denied on
 * unattended factory runs because the server can run queries against
 * production databases; attended sessions are ungated. Database access
 * levels (read-only vs full) are configured on the PlanetScale side.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isAutonomous(ctx.session.auth.current)
      ? {
          reason: "Unattended factory runs do not query PlanetScale.",
          type: "denied",
        }
      : "not-applicable",
  auth: connect({
    connector: requireEnv(
      "PLANETSCALE_MCP_CONNECTOR",
      "planetscale/acquisity-foreman-planetscale"
    ),
    principalType: "app",
  }),
  description:
    "PlanetScale Postgres: organizations, databases, branches, schema, and query Insights.",
  url: "https://mcp.pscale.dev/mcp/planetscale",
});
