import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * App-scoped via Vercel Connect (BYO OAuth app from the Intercom Developer
 * Hub); tokens are minted per call and never exposed to the model.
 * Available to every session, unattended runs included. Read-only by tool
 * allowlist, built from the server's live tool list; article writes and
 * feedback submission are excluded, and no reply-to-customer surface is
 * admitted.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv("INTERCOM_MCP_CONNECTOR", "intercom/foreman"),
    principalType: "app",
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
