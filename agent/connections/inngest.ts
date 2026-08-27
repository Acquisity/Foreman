import { defineMcpClientConnection } from "eve/connections";
import { inngestAuth } from "../lib/inngest-api-auth.js";

/**
 * Inngest Cloud MCP connection for background-job investigation.
 *
 * @remarks
 * Inngest Cloud MCP authenticates with an API key (no OAuth). The key is
 * held by a Vercel Connect api-key connector (created in the Connect
 * dashboard: API Key type, service api.inngest.com/mcp), so the runtime
 * resolves it per call like every other connection and it never reaches the
 * model. Available to every session, unattended runs included — functions,
 * events, runs, and failures are core bug-investigation evidence.
 *
 * Read-only by allowlist: the Cloud server also ships write tools
 * (send_event, invoke_function, rerun, cancel_run, create/patch/sync) and
 * credential-returning reads (fetch_account_*_keys, list_session_keys);
 * none of those belong in an ungated investigation surface. Tool names from
 * the Inngest MCP docs; verify against the live list when touching this.
 */
export default defineMcpClientConnection({
  auth: inngestAuth,
  description:
    "Inngest background jobs, read-only: environments, functions, events, runs, traces, failure history, and Insights queries.",
  tools: {
    allow: [
      "health",
      "get_app",
      "get_apps",
      "get_function",
      "list_functions",
      "get_run",
      "get_run_trace",
      "list_runs",
      "list_function_runs",
      "get_event_runs",
      "list_envs",
      "list_webhooks",
      "query_insights",
      "list_insights_tables",
      "list_insights_event_schemas",
    ],
  },
  url: "https://api.inngest.com/mcp",
});
