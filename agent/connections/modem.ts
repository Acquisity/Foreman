import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Modem MCP connection for customer feedback evidence.
 *
 * @remarks
 * App-scoped via Vercel Connect against Modem's hosted server; tokens are
 * minted per call and never exposed to the model. The connector holds a
 * hand-registered public OAuth client (Modem's dynamic registration only
 * allows client_credentials for authenticated callers) plus a one-time
 * user consent. Modem's MCP enforces RFC 8707 resource binding: tokens
 * minted without `resources` pointing at the MCP URL are valid at the auth
 * server but rejected by the MCP, so keep that token param in place.
 * Available to every session, unattended runs included. Read-only twice
 * over: the token's only data scope is `data:read` (`offline_access` just
 * enables refresh tokens), and the allowlist admits only `search_modem` —
 * `invoke_modem_agent` (scope `agent:invoke`) is excluded at both layers.
 */
const MODEM_MCP_URL = "https://mcp.modem.dev/mcp";

export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "MODEM_MCP_CONNECTOR",
      "mcp.modem.dev/acquisity-foreman-modem"
    ),
    principalType: "app",
    tokenParams: {
      resources: [MODEM_MCP_URL],
      scopes: ["data:read", "offline_access"],
    },
  }),
  description:
    "Modem customer feedback, read-only: natural-language search over feedback, topics, people, and companies.",
  tools: { allow: ["search_modem"] },
  url: MODEM_MCP_URL,
});
