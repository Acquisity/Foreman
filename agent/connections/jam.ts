import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Jam MCP connection for bug report context.
 *
 * @remarks
 * User-scoped via Vercel Connect (OAuth registration against Jam's hosted
 * server); uses the authorization-code grant: a one-time consent stores a
 * refresh token, after which calls are non-interactive and auto-refreshing,
 * and tokens are never exposed to the model.
 * Available to every session, unattended runs included — Jam recordings
 * (console logs, network traces, repro steps) are core bug-investigation
 * evidence. Read-only by tool allowlist, built from the server's live tool
 * list; comments, reactions, folder/link management, and archiving are
 * excluded.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "JAM_MCP_CONNECTOR",
      "mcp.jam.dev/acquisity-foreman-jam"
    ),
    principalType: "user",
  }),
  description:
    "Jam bug reports, read-only: recordings, console logs, network requests, screenshots, user events, and video transcripts.",
  tools: {
    allow: [
      "analyzeVideo",
      "fetch",
      "getConsoleLogs",
      "getDetails",
      "getFrames",
      "getMetadata",
      "getNetworkRequests",
      "getRecordingLink",
      "getRecordingUrlVerifyLink",
      "getScreenshots",
      "getUserEvents",
      "getVideoTranscript",
      "listFolders",
      "listJams",
      "listMembers",
      "listRecordingLinkJams",
      "listRecordingLinks",
      "listRecordingUrls",
      "search",
    ],
  },
  url: "https://mcp.jam.dev/mcp",
});
