import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { managedConnect } from "../lib/managed-connect.js";

/**
 * Raindrop MCP connection for AI-product observability evidence.
 *
 * @remarks
 * Raindrop's OAuth registration allowlists redirect URIs and rejects Vercel
 * Connect's callback, so this authenticates with a static Query SDK API key
 * (created at app.raindrop.ai, Settings, API Keys) held by a Connect api-key
 * connector; the runtime resolves it per call and it never reaches the model.
 * App-scoped on purpose: an api-key connector serves only the app subject,
 * and a per-user grant cannot exist for requesters who have no Raindrop
 * account. Available to every session, unattended runs included, because
 * events, traces, issues, and signals are bug-investigation evidence.
 * Read-only by allowlist: excluded are `update_issue`, the signal-session,
 * memory, and dataset writes, `get_write_key`, `submit_feedback`, feature
 * flag reads, and `ask_agent_question`, which starts a paid investigation.
 */
export default defineMcpClientConnection({
  auth: managedConnect({
    connector: requireEnv(
      "RAINDROP_MCP_CONNECTOR",
      "api.raindrop.ai/acquisity-foreman-raindrop"
    ),
    principalType: "app",
  }),
  description:
    "Raindrop AI observability, read-only: LLM events, traces, conversations, stumbles, signals, and issues.",
  tools: {
    allow: [
      "list_events",
      "get_event",
      "search_events",
      "get_event_count",
      "get_event_timeseries",
      "get_event_facets",
      "get_error_span_facets",
      "get_trace",
      "list_conversations",
      "get_conversation",
      "search_stumbles",
      "list_signals",
      "get_signal",
      "list_signal_groups",
      "get_signal_group",
      "list_issues",
      "get_issue",
      "get_issue_events",
      "get_issue_timeseries",
      "list_projects",
      "list_users",
      "get_user",
      "search_docs",
    ],
  },
  url: "https://mcp.raindrop.ai/mcp",
});
