import { defineMcpClientConnection } from "eve/connections";
import { planetscaleAuth } from "../lib/constants.js";

/**
 * PlanetScale MCP connection for production database investigation.
 *
 * @remarks
 * - Authenticated with a PlanetScale service token held by a Vercel Connect
 *   api-key connector (created in the Connect dashboard: API Key type). The
 *   runtime resolves it per call like every other connection and it never
 *   reaches the model.
 * - Read-only on two layers: the token grants the read-only set
 *   (`read_organization`, `read_databases`, `read_database`, `read_branch`)
 *   plus read-query permissions (`connect_production_read_only_branch`,
 *   `delete_production_read_only_branch_password`), with
 *   `connect_production_branch` left off so writes stay blocked. The tool
 *   allowlist also excludes `planetscale_execute_write_query`. Read queries
 *   run as a short-lived `pg_read_all_data` role and respect row-level
 *   security.
 * - `planetscale_execute_read_query` is intentionally absent from the
 *   allowlist: it returns the full rows array with no size limit, which can
 *   exceed the workflow stream's per-chunk limit. The authored
 *   `planetscale_execute_read_query` tool (agent/tools) calls it directly and
 *   truncates the result instead.
 * - Ungated on purpose: unattended factory runs investigate bug tickets and
 *   must assess fleet-wide blast radius. The service token is scoped to a
 *   single organization, so reach across databases is a property of the
 *   token's grants rather than the auth mode.
 */
export default defineMcpClientConnection({
  auth: planetscaleAuth,
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
      "planetscale_get_insights",
      "planetscale_list_schema_recommendations",
      "planetscale_search_documentation",
    ],
  },
  url: "https://mcp.pscale.dev/mcp/planetscale",
});
