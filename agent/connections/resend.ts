import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Resend MCP connection for transactional email evidence.
 *
 * @remarks
 * App-scoped via Vercel Connect (MCP automatic registration); tokens are
 * minted per call and never exposed to the model. Available to every
 * session, unattended runs included. TODO(read-only filter): once the
 * connector is authorized, list the server's tools and allowlist the
 * read-only surface (email sending and broadcast writes excluded).
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "RESEND_MCP_CONNECTOR",
      "resend/acquisity-foreman-resend"
    ),
    principalType: "app",
  }),
  description:
    "Resend email: domains, audiences, broadcasts, and email delivery status.",
  url: "https://mcp.resend.com/mcp",
});
