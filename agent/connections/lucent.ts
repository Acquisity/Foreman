import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Lucent MCP connection for session-replay bug evidence.
 *
 * @remarks
 * Lucent's OAuth registration endpoint allowlists redirect URIs and does
 * not accept Vercel Connect's callback, so this authenticates with a static
 * MCP token (`luc_mcp_…`, created in Lucent organization settings) held by
 * a Vercel Connect api-key connector; the runtime resolves it per call and
 * it never reaches the model. Available to every session, unattended runs
 * included — issues, signals, and session insights are bug-investigation
 * evidence. Read-only twice over: Lucent tokens carry only `read:lucent`
 * unless write scopes are granted at creation, and the allowlist excludes
 * the one write tool, `update_issue`.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "LUCENT_MCP_CONNECTOR",
      "app.lucenthq.com/acquisity-foreman-lucent"
    ),
    principalType: "app",
  }),
  description:
    "Lucent session replay, read-only: user-hit issues and periodic session insights.",
  tools: { allow: ["list_issues", "get_issue", "list_insights"] },
  url: "https://app.lucenthq.com/api/mcp",
});
