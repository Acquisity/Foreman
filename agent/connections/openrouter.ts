import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { denyUnattendedWrites } from "../lib/github/approval.js";
import { userConnect } from "../lib/user-connect.js";

const WRITE_TOOLS = ["send-message"] as const;

export default defineMcpClientConnection({
  approval: denyUnattendedWrites("OpenRouter", WRITE_TOOLS),
  auth: userConnect({
    connector: requireEnv(
      "OPENROUTER_MCP_CONNECTOR",
      "mcp.openrouter.ai/acquisity-foreman-openrouter"
    ),
    principalType: "user",
  }),
  description:
    "OpenRouter model intelligence: model catalog, provider capabilities, pricing, benchmarks, usage rankings, account credit, and documentation. Test inference is attended-only because it incurs spend.",
  tools: {
    allow: [
      "list-models",
      "get-model",
      "list-model-endpoints",
      "list-benchmarks",
      "list-daily-model-rankings",
      "get-generation",
      "search-docs",
      "get-credits",
      "list-providers",
      "list-app-rankings",
      ...WRITE_TOOLS,
    ],
  },
  url: "https://mcp.openrouter.ai/mcp",
});
