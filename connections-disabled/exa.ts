import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../agent/lib/constants.js";

/**
 * Exa MCP connection for web search and research.
 *
 * @remarks
 * App-scoped via Vercel Connect (OAuth registration against Exa's hosted
 * server). Ungated on purpose: every tool is a read-only search over the
 * public web, and unattended stations (analyst, reviewer) benefit from
 * research access.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "EXA_MCP_CONNECTOR",
      "mcp.exa.ai/acquisity-foreman-exa"
    ),
    principalType: "app",
  }),
  description:
    "Exa web search: semantic search, page contents, and deep research over the public web.",
  url: "https://mcp.exa.ai/mcp",
});
