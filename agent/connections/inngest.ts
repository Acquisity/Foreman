import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Inngest Cloud MCP connection for background-job investigation.
 *
 * @remarks
 * Inngest Cloud MCP authenticates with an API key (no OAuth). The key is
 * held by a Vercel Connect api-key connector (created with
 * `vercel connect create api.inngest.com/mcp --connector-type api-key`), so
 * the runtime resolves it per call like every other connection and it never
 * reaches the model. Available to every session, unattended runs included —
 * functions, events, runs, and failures are core bug-investigation evidence.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "INNGEST_MCP_CONNECTOR",
      "api.inngest.com/acquisity-foreman-inngest"
    ),
    principalType: "app",
  }),
  description:
    "Inngest background jobs: environments, functions, events, runs, steps, and failure history.",
  url: "https://api.inngest.com/mcp",
});
