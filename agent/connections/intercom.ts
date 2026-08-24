import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * App-scoped through Vercel Connect using the access token from Foreman's
 * private Intercom app. The app belongs to Acquisity's own workspace, so it
 * needs no per-user OAuth flow or public-app review. The token is never
 * exposed to the model.
 * Available to every session, unattended runs included. Read-only by both the
 * private app's permissions and this tool allowlist; article tools, feedback
 * submission, and every reply-to-customer surface are excluded.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "INTERCOM_MCP_CONNECTOR",
      "api.intercom.com/acquisity-foreman-intercom-api"
    ),
    principalType: "app",
  }),
  description:
    "Intercom customer support, read-only: conversations, contacts, and companies.",
  tools: {
    allow: [
      "fetch",
      "get_company",
      "get_contact",
      "get_conversation",
      "list_companies",
      "search",
      "search_contacts",
      "search_conversations",
    ],
  },
  url: "https://mcp.intercom.com/mcp",
});
