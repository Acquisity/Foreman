import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Resend MCP connection for transactional email evidence.
 *
 * @remarks
 * User-scoped via Vercel Connect (MCP automatic registration); uses the
 * authorization-code grant: a one-time consent stores a refresh token,
 * after which calls are non-interactive and auto-refreshing, and tokens are
 * never exposed to the model. Available to every
 * session, unattended runs included. Resend's OAuth grants `full_access`
 * only, so read-only is enforced here: the allowlist admits every `get-*` /
 * `list-*` tool from the server's live tool list and nothing else — no
 * sending, no create/update/remove, no suppression edits.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: requireEnv(
      "RESEND_MCP_CONNECTOR",
      "resend/acquisity-foreman-resend"
    ),
    principalType: "user",
  }),
  description:
    "Resend email, read-only: delivery status, logs, domains, contacts, segments, broadcasts, templates, and suppressions.",
  tools: {
    allow: [
      "get-automation",
      "get-automation-runs",
      "get-broadcast",
      "get-contact",
      "get-contact-import",
      "get-contact-property",
      "get-domain",
      "get-domain-claim",
      "get-email",
      "get-log",
      "get-received-email",
      "get-received-email-attachment",
      "get-segment",
      "get-sent-email-attachment",
      "get-suppression",
      "get-template",
      "get-tiptap-json-content",
      "get-topic",
      "get-webhook",
      "list-api-keys",
      "list-broadcasts",
      "list-contact-imports",
      "list-contact-properties",
      "list-contact-segments",
      "list-contact-topics",
      "list-contacts",
      "list-domains",
      "list-emails",
      "list-logs",
      "list-oauth-grants",
      "list-received-email-attachments",
      "list-received-emails",
      "list-segments",
      "list-sent-email-attachments",
      "list-suppressions",
      "list-templates",
      "list-topics",
      "list-webhooks",
    ],
  },
  url: "https://mcp.resend.com/mcp",
});
