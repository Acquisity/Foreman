import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../agent/lib/constants.js";

/**
 * Sentry MCP connection for bug investigation evidence.
 *
 * @remarks
 * - App-scoped via Vercel Connect (MCP automatic registration). Tokens are
 *   minted per call and never exposed to the model. Available to every
 *   session, unattended runs included.
 * - Read-only by consent, not by tool filter: the installation was granted
 *   only the "Inspect Issues & Events" capability (37 read-only tools —
 *   issues, events, traces, session replays, releases, monitors, profiles),
 *   so the server's meta-tools (`search_sentry_tools`,
 *   `execute_sentry_tool`) can only reach read-only tools. Triage, Seer,
 *   and project/team management were declined at consent; re-consenting
 *   with more capabilities would widen this connection, so don't.
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
    "Sentry error tracking, read-only: issues, events, stack traces, breadcrumbs, traces, session replays, releases, and performance data.",
  url: "https://mcp.sentry.dev/mcp",
});
