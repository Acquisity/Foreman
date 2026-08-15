import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Jam MCP connection for bug report context.
 *
 * @remarks
 * App-scoped via Vercel Connect (OAuth registration against Jam's hosted
 * server); tokens are minted per call and never exposed to the model.
 * Available to every session, unattended runs included — Jam recordings
 * (console logs, network traces, repro steps) are core bug-investigation
 * evidence. The surface is read-only by nature.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "JAM_MCP_CONNECTOR",
      "mcp.jam.dev/acquisity-foreman-jam"
    ),
    principalType: "app",
  }),
  description:
    "Jam bug reports: recordings, console logs, network traces, and reproduction details.",
  url: "https://mcp.jam.dev/mcp",
});
