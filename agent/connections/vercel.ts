import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { denyAutonomousWrites } from "../lib/github/approval.js";

/**
 * Tools that mutate Vercel state. Allowed in attended sessions, denied on
 * unattended factory runs so a prompt-injected labeled issue can never
 * deploy or post to toolbar threads.
 */
const WRITE_TOOLS = [
  "deploy_to_vercel",
  "change_toolbar_thread_resolve_status",
  "reply_to_toolbar_thread",
  "edit_toolbar_message",
  "add_toolbar_reaction",
] as const;

/**
 * Vercel MCP connection for deployment observability and attended deploys.
 *
 * @remarks
 * - Points at Vercel's hosted MCP server and authenticates app-scoped
 *   through a Vercel Connect connector (created from the dashboard's
 *   Connect page or `vercel connect create mcp.vercel.com`), so tokens are
 *   minted per call and never exposed to the model.
 * - The allowlist excludes purchases (domains, credits, addons) and
 *   `use_vercel_cli` (arbitrary CLI execution) entirely — no session should
 *   reach those. Write tools on the allowlist are approval-gated to
 *   attended sessions only. New tools the server grows must be added here
 *   explicitly.
 */
export default defineMcpClientConnection({
  approval: denyAutonomousWrites("Vercel", WRITE_TOOLS),
  auth: connect({
    connector: requireEnv(
      "VERCEL_MCP_CONNECTOR",
      "mcp.vercel.com/acquisity-foreman"
    ),
    principalType: "app",
  }),
  description:
    "Vercel platform: projects, deployments, build and runtime logs, runtime errors, web analytics, toolbar threads, deploys, and Vercel documentation search.",
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
      "list_toolbar_threads",
      "get_toolbar_thread",
      ...WRITE_TOOLS,
    ],
  },
  url: "https://mcp.vercel.com",
});
