import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { denyUnattendedWrites } from "../lib/github/approval.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Supermemory MCP connection for recalling and saving team context.
 *
 * @remarks
 * User-scoped via Vercel Connect. Supermemory's MCP rejects machine
 * (client_credentials) tokens, and its dynamic registration only mints
 * those for authenticated callers, so the connector holds a hand-registered
 * confidential OAuth client (registered against
 * `api.supermemory.ai/api/auth` with the Connect callback) plus a one-time
 * user consent; the runtime refreshes tokens per call and none of it
 * reaches the model.
 *
 * Recall tools are ungated evidence. The one write in the allowlist,
 * `add_memory`, is denied on unattended runs so a poisoned issue body
 * cannot plant durable context every future session recalls; attended
 * sessions write without a card because a memory is scoped and
 * deletable, unlike authoritative repository knowledge. The server's interactive
 * widget tools (guided-save, upload-file, memory-graph, space switching)
 * are excluded: they target human MCP clients, not stations.
 */
export default defineMcpClientConnection({
  approval: denyUnattendedWrites("Supermemory", ["add_memory"]),
  auth: userConnect({
    connector: requireEnv(
      "SUPERMEMORY_MCP_CONNECTOR",
      "mcp.supermemory.ai/acquisity-foreman-supermemory"
    ),
    principalType: "user",
  }),
  description:
    "Supermemory: semantic recall over saved memories, documents, and spaces, plus saving new memories on attended runs.",
  tools: {
    allow: [
      "search_memory",
      "listDocuments",
      "getDocument",
      "listMemories",
      "listSpaces",
      "whoAmI",
      "add_memory",
    ],
  },
  url: "https://mcp.supermemory.ai/mcp",
});
