import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Modem MCP connection for customer feedback evidence.
 *
 * @remarks
 * App-scoped via Vercel Connect against Modem's hosted server; tokens are
 * minted per call and never exposed to the model. Available to every
 * session, unattended runs included. Read-only twice over: the token
 * requests only the `data:read` scope, and the allowlist admits only
 * `search_modem` — the agent-invocation and topic/company/people write
 * tools (scope `agent:invoke`) are excluded at both layers.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "MODEM_MCP_CONNECTOR",
      "mcp.modem.dev/acquisity-foreman-modem"
    ),
    principalType: "app",
    tokenParams: { scopes: ["data:read"] },
  }),
  description:
    "Modem customer feedback, read-only: natural-language search over feedback, topics, people, and companies.",
  tools: { allow: ["search_modem"] },
  url: "https://mcp.modem.dev/mcp",
});
