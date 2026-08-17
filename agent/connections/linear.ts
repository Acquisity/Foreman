import { defineMcpClientConnection } from "eve/connections";
import { linearAuth } from "../lib/constants.js";
import { denyAutonomousWrites } from "../lib/github/approval.js";

/**
 * Linear MCP connection for creating and cross-referencing issues.
 *
 * @remarks
 * - Points at Linear's hosted MCP server and authenticates with the shared
 *   app-scoped `linearAuth` from `agent/lib/constants.ts`, so this connection
 *   and any tool calling the Linear API directly share one installation and
 *   one set of scopes. Tokens are resolved per call and never exposed to the
 *   model.
 * - The connection-wide approval predicate denies unattended factory runs, so
 *   a prompt-injected labeled issue cannot fan out into the tracker. Every
 *   attended session keeps the tools ungated: Linear writes are app-scoped
 *   and reversible, as before.
 */
export default defineMcpClientConnection({
  approval: denyAutonomousWrites("Linear"),
  auth: linearAuth,
  description: "Linear workspace: issues, projects, cycles, and comments.",
  url: "https://mcp.linear.app/mcp",
});
