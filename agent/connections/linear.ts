import { defineMcpClientConnection } from "eve/connections";
import { linearAuth } from "../lib/constants.js";
import { denyUnattendedWrites } from "../lib/github/approval.js";
import { isAutonomous } from "../lib/trust.js";

/**
 * The only Linear tools a scheduled run may reach. Everything else on the
 * connection stays denied for it, so the list never has to keep up with the
 * writes the hosted server grows.
 */
const SCHEDULED_READ_TOOLS = ["list_issues", "get_issue"] as const;

const denyWrites = denyUnattendedWrites("Linear");

/**
 * Linear MCP connection for creating and cross-referencing issues.
 *
 * @remarks
 * - Points at Linear's hosted MCP server and authenticates with the shared
 *   app-scoped `linearAuth` from `agent/lib/constants.ts`, so this connection
 *   and any tool calling the Linear API directly share one installation and
 *   one set of scopes. Tokens are resolved per call and never exposed to the
 *   model.
 * - The connection-wide approval predicate denies every tool to unattended
 *   factory runs, so a prompt-injected labeled issue cannot fan out into the
 *   tracker. Every attended session keeps the tools ungated: Linear writes
 *   are app-scoped and reversible, as before.
 * - Schedules dispatching under a real user (the SLA report) are unattended
 *   too, but reading the tracker is the whole point of them, so they keep
 *   {@link SCHEDULED_READ_TOOLS} and are denied everything else. Factory runs
 *   are excluded from that exception deliberately: their input is an issue
 *   body a stranger can write.
 */
export default defineMcpClientConnection({
  approval: (ctx) => {
    const isScheduledRead =
      !isAutonomous(ctx.session.auth.current) &&
      SCHEDULED_READ_TOOLS.some(
        (tool) => ctx.toolName === tool || ctx.toolName.endsWith(`__${tool}`)
      );
    return isScheduledRead ? "not-applicable" : denyWrites(ctx);
  },
  auth: linearAuth,
  description: "Linear workspace: issues, projects, cycles, and comments.",
  url: "https://mcp.linear.app/mcp",
});
