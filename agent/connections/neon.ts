import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Neon MCP connection for database investigation.
 *
 * @remarks
 * - User-scoped via Vercel Connect (custom OAuth against mcp.neon.tech).
 *   Uses the authorization-code grant: a one-time consent stores a refresh
 *   token, after which calls are non-interactive and auto-refreshing, and
 *   tokens are never exposed to the model.
 * - The `?readonly=true` URL is the write guard: it disables write tools
 *   server-side, restricts run_sql/run_sql_transaction to read queries, and
 *   withholds connection strings. The allowlist below only trims the surface;
 *   run_sql would accept writes without that URL flag, so keep it in place.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "NEON_MCP_CONNECTOR",
      "mcp.neon.tech/acquisity-foreman-neon"
    ),
    principalType: "user",
  }),
  description:
    "Neon Postgres, read-only: projects, branches, schema, read queries, slow queries, explain plans, and logs.",
  tools: {
    allow: [
      "list_projects",
      "describe_project",
      "list_organizations",
      "describe_branch",
      "list_branch_computes",
      "compare_database_schema",
      "run_sql",
      "run_sql_transaction",
      "get_database_tables",
      "describe_table_schema",
      "list_slow_queries",
      "explain_sql_statement",
      "inspect_database",
      "query_logs",
      "list_log_fields",
      "list_log_field_values",
    ],
  },
  url: "https://mcp.neon.tech/mcp?readonly=true",
});
