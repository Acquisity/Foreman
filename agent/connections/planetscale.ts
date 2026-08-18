import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * PlanetScale MCP connection for production database investigation.
 *
 * @remarks
 * - User-scoped via Vercel Connect (MCP automatic registration). Uses the
 *   authorization-code grant: a one-time consent stores a refresh token,
 *   after which calls are non-interactive and auto-refreshing, and tokens
 *   are never exposed to the model.
 * - Ungated on purpose: unattended factory runs investigate bug tickets and
 *   must assess fleet-wide blast radius, so queries are deliberately not
 *   pinned to one organization. Safety comes from the read-only allowlist —
 *   `planetscale_execute_write_query` is excluded — plus PlanetScale-side
 *   scopes: read queries run as a short-lived `pg_read_all_data` role and
 *   respect row-level security.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "PLANETSCALE_MCP_CONNECTOR",
      "planetscale/acquisity-foreman-planetscale"
    ),
    principalType: "user",
  }),
  description:
    "PlanetScale Postgres, read-only: organizations, databases, branches, schema, read queries against production data, and query Insights.",
  tools: {
    allow: [
      "planetscale_list_organizations",
      "planetscale_get_organization",
      "planetscale_list_databases",
      "planetscale_get_database",
      "planetscale_list_branches",
      "planetscale_get_branch",
      "planetscale_get_branch_schema",
      "planetscale_execute_read_query",
      "planetscale_get_insights",
      "planetscale_list_schema_recommendations",
      "planetscale_search_documentation",
    ],
  },
  url: "https://mcp.pscale.dev/mcp/planetscale",
});
