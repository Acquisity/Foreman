import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * User-scoped via Vercel Connect (BYO OAuth app from the Intercom Developer
 * Hub); uses the authorization-code grant: a one-time consent stores a
 * refresh token, after which calls are non-interactive and auto-refreshing,
 * and tokens are never exposed to the model.
 * Available to every session, unattended runs included. Read-only by tool
 * allowlist, built from the server's live tool list; article writes and
 * feedback submission are excluded, and no reply-to-customer surface is
 * admitted.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv("INTERCOM_MCP_CONNECTOR", "intercom/foreman"),
    principalType: "user",
  }),
  description:
    "Intercom customer support, read-only: conversations, contacts, companies, and help center articles.",
  tools: {
    allow: [
      "fetch",
      "get_article",
      "get_company",
      "get_contact",
      "get_conversation",
      "list_articles",
      "list_companies",
      "search",
      "search_articles",
      "search_contacts",
      "search_conversations",
    ],
  },
  url: "https://mcp.intercom.com/mcp",
});
