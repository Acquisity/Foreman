import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Sentry MCP connection for bug investigation evidence.
 *
 * @remarks
 * - App-scoped via Vercel Connect (MCP automatic registration). Tokens are
 *   minted per call and never exposed to the model.
 * - Ungated on purpose: unattended factory runs investigate bug tickets
 *   before coding, so safety comes from the strict read-only tool allowlist,
 *   not an approval gate. Every mutating tool (issue notes/updates, project,
 *   team, DSN, and monitor writes, Seer analysis runs) is excluded.
 * - Session Replay evidence is covered natively by `get_replay_details`.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "SENTRY_MCP_CONNECTOR",
      "sentry/acquisity-foreman-sentry"
    ),
    principalType: "app",
  }),
  description:
    "Sentry error tracking, read-only: issues, events, stack traces, breadcrumbs, traces, spans, profiles, session replays, releases, and performance data.",
  tools: {
    allow: [
      "whoami",
      "find_organizations",
      "find_projects",
      "find_teams",
      "find_releases",
      "find_dsns",
      "find_alert_rules",
      "find_dashboards",
      "find_monitors",
      "find_uptime_monitors",
      "search_issues",
      "search_events",
      "search_issue_events",
      "get_issue_details",
      "get_issue_activity",
      "get_issue_breadcrumbs",
      "get_issue_tag_values",
      "get_issue_user_reports",
      "get_event_stacktrace",
      "get_event_attachment",
      "get_trace_details",
      "get_span_details",
      "get_profile",
      "get_profile_details",
      "get_replay_details",
      "get_release_details",
      "get_alert_rule",
      "get_dashboard_details",
      "get_monitor_details",
      "get_uptime_monitor_details",
      "get_sentry_resource",
      "get_latest_base_snapshot",
      "get_snapshot",
      "get_snapshot_image",
      "search_ai_conversations",
      "get_ai_conversation_details",
      "search_docs",
      "get_doc",
    ],
  },
  url: "https://mcp.sentry.dev/mcp",
});
