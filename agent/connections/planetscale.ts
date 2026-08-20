import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * PlanetScale MCP connection for production database investigation.
 *
 * @remarks
 * - Authenticated with a PlanetScale service token held by a Vercel Connect
 *   api-key connector (created in the Connect dashboard: API Key type). The
 *   runtime resolves it per call like every other connection and it never
 *   reaches the model.
 * - Read-only on two layers: the token grants read-query permissions only
 *   (`connect_production_read_only_branch`, not `connect_production_branch`),
 *   and the tool allowlist excludes `planetscale_execute_write_query`. Read
 *   queries run as a short-lived `pg_read_all_data` role and respect
 *   row-level security.
 * - Ungated on purpose: unattended factory runs investigate bug tickets and
 *   must assess fleet-wide blast radius, so queries are deliberately not
 *   pinned to one organization.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "PLANETSCALE_MCP_CONNECTOR",
      "planet-scale-read-only-foreman/acquisity-foreman-planet-scale"
    ),
    principalType: "app",
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
