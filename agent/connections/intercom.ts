import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * App-scoped via Vercel Connect; tokens are minted per call and never
 * exposed to the model. Available to every session, unattended runs
 * included. TODO(read-only filter): once the connector is authorized, list
 * the server's tools and allowlist the read-only surface (replying to
 * customers excluded).
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv("INTERCOM_MCP_CONNECTOR", "intercom/foreman"),
    principalType: "app",
  }),
  description:
    "Intercom customer support: conversations, contacts, companies, and help center articles.",
  url: "https://mcp.intercom.com/mcp",
});
