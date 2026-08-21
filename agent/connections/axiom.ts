import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Axiom MCP connection for production log queries.
 *
 * @remarks
 * User-scoped via Vercel Connect (OAuth registration against Axiom's hosted
 * server); uses the authorization-code grant: a one-time consent stores a
 * refresh token, after which calls are non-interactive and auto-refreshing,
 * and tokens are never exposed to the model.
 * Available to every session, unattended runs included — log evidence is
 * core bug-investigation input. Read-only by tool allowlist, built from
 * the server's live tool list: queries, datasets, metrics, and monitor
 * history stay; dashboard/monitor/notifier writes are excluded.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "AXIOM_MCP_CONNECTOR",
      "mcp.axiom.co/acquisity-foreman-axiom"
    ),
    principalType: "user",
  }),
  description:
    "Axiom observability, read-only: APL queries over production structured logs, datasets, metrics, dashboards, and monitor history.",
  tools: {
    allow: [
      "checkMonitors",
      "exportDashboard",
      "getDashboard",
      "getDatasetFields",
      "getMetricTagValues",
      "getMonitorHistory",
      "getSavedQueries",
      "listDashboards",
      "listDatasets",
      "listMetricTags",
      "listMetrics",
      "listNotifiers",
      "queryDataset",
      "queryMetrics",
      "searchMetrics",
    ],
  },
  url: "https://mcp.axiom.co/mcp",
});
