import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Vercel MCP connection for deployment observability.
 *
 * @remarks
 * - Points at Vercel's hosted MCP server and authenticates app-scoped
 *   through a Vercel Connect connector (created with
 *   `vercel connect create mcp.vercel.com --connection-method mcp`), so
 *   tokens are minted per call and never exposed to the model.
 * - The tool allowlist is read-only on purpose: the server also exposes
 *   deploys, purchases (domains, credits, addons), and arbitrary CLI
 *   execution, none of which an unattended factory run should reach.
 *   Foreman deploys through git, never through MCP. New read-only tools
 *   the server grows must be added here explicitly.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "VERCEL_MCP_CONNECTOR",
      "mcp.vercel.com/acquisity-foreman"
    ),
    principalType: "app",
  }),
  description:
    "Vercel platform: projects, deployments, build and runtime logs, runtime errors, web analytics, and Vercel documentation search. Read-only.",
  tools: {
    allow: [
      "search_vercel_documentation",
      "list_teams",
      "list_projects",
      "get_project",
      "list_deployments",
      "get_deployment",
      "get_deployment_build_logs",
      "get_runtime_logs",
      "get_runtime_errors",
      "get_web_analytics",
      "list_agent_run_projects",
      "list_agent_runs",
      "get_agent_run",
      "get_agent_run_trace",
      "get_access_to_vercel_url",
      "web_fetch_vercel_url",
    ],
  },
  url: "https://mcp.vercel.com",
});
