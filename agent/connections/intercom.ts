import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { requireEnv } from "../lib/constants.js";
import {
  canUseInvestigationMemory,
  isAutonomous,
  isTrusted,
} from "../lib/trust.js";

const intercomReadPolicy = (ctx: ApprovalContext): ApprovalStatus => {
  const auth = ctx.session.auth.current;
  return isTrusted(auth) ||
    isAutonomous(auth) ||
    canUseInvestigationMemory(auth)
    ? "not-applicable"
    : {
        reason:
          "Intercom customer data is limited to trusted internal and explicitly authorized factory sessions.",
        type: "denied",
      };
};

/**
 * Intercom MCP connection for customer conversation context.
 *
 * @remarks
 * App-scoped through Vercel Connect using the access token from Foreman's
 * private Intercom app. The app belongs to Acquisity's own workspace, so it
 * needs no per-user OAuth flow or public-app review. The token is never
 * exposed to the model.
 * Available to trusted internal sessions, attended investigation surfaces,
 * and explicitly triggered autonomous factory runs. Untrusted GitHub sessions,
 * including outside-contributor pull request summaries, are denied before a
 * tool executes. Read-only by both the private app's permissions and this tool
 * allowlist; article tools, feedback submission, and every reply-to-customer
 * surface are excluded.
 */
export default defineMcpClientConnection({
  approval: intercomReadPolicy,
  auth: connect({
    connector: requireEnv(
      "INTERCOM_MCP_CONNECTOR",
      "api.intercom.com/acquisity-foreman-intercom-api"
    ),
    principalType: "app",
  }),
  description:
    "Intercom customer support, read-only: conversations, contacts, and companies.",
  tools: {
    allow: [
      "fetch",
      "get_company",
      "get_contact",
      "get_conversation",
      "list_companies",
      "search",
      "search_contacts",
      "search_conversations",
    ],
  },
  url: "https://mcp.intercom.com/mcp",
});
