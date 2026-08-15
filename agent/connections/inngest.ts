import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Inngest Cloud MCP connection for background-job investigation.
 *
 * @remarks
 * Inngest Cloud MCP authenticates with an API key (no OAuth), so this uses
 * eve's static-token auth: the runtime sends `INNGEST_API_KEY` as the Bearer
 * token per call and the key is never exposed to the model. The key is read
 * lazily so a deployment without it still boots; calls fail with a clear
 * message instead. Create the key at https://app.inngest.com/mcp/setup.
 * Available to every session, unattended runs included — functions, events,
 * runs, and failures are core bug-investigation evidence.
 */
export default defineMcpClientConnection({
  auth: {
    getToken: async () => ({
      token: requireEnv("INNGEST_API_KEY", "signkey-prod-..."),
    }),
  },
  description:
    "Inngest background jobs: environments, functions, events, runs, steps, and failure history.",
  url: "https://api.inngest.com/mcp",
});
