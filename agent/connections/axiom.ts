import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Axiom MCP connection for production log queries.
 *
 * @remarks
 * App-scoped via Vercel Connect (OAuth registration against Axiom's hosted
 * server); tokens are minted per call and never exposed to the model.
 * Available to every session, unattended runs included — log evidence is
 * core bug-investigation input. TODO(read-only filter): once the connector
 * is authorized, list the server's tools and allowlist the read-only
 * surface if it exposes writes (e.g. monitors or dataset management).
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "AXIOM_MCP_CONNECTOR",
      "mcp.axiom.co/acquisity-foreman-axiom"
    ),
    principalType: "app",
  }),
  description:
    "Axiom observability: datasets and APL queries over production structured logs.",
  url: "https://mcp.axiom.co/mcp",
});
