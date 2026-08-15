import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * PostHog MCP connection for product analytics evidence.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration); tokens are
 * minted per call and never exposed to the model. Available to every
 * session, unattended runs included. TODO(read-only filter): once the
 * connector is authorized, list the server's tools and allowlist the
 * read-only surface (feature-flag and insight writes excluded).
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "POSTHOG_MCP_CONNECTOR",
      "posthog/acquisity-foreman-posthog"
    ),
    principalType: "app",
  }),
  description:
    "PostHog product analytics: events, insights, funnels, session data, feature flags, and experiments.",
  url: "https://mcp.posthog.com/mcp",
});
