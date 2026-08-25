import { defineMcpClientConnection } from "eve/connections";
import vercel from "../../../connections/vercel.js";
import { withoutConsent } from "../../../lib/user-connect.js";

/**
 * Tools on the root Vercel allowlist that mutate state. The critic gets the
 * root allowlist minus these; the root `approval` predicate stays attached
 * even though nothing it gates remains, so the read-only filter only narrows.
 */
export const VERCEL_WRITE_TOOLS = [
  "deploy_to_vercel",
  "change_toolbar_thread_resolve_status",
  "reply_to_toolbar_thread",
  "edit_toolbar_message",
  "add_toolbar_reaction",
] as const;

const rootAllow =
  vercel.tools && "allow" in vercel.tools ? vercel.tools.allow : [];

export default defineMcpClientConnection({
  ...vercel,
  auth: withoutConsent(vercel.auth),
  description:
    "Vercel, read-only: deployments, build and runtime logs, runtime errors, analytics, and toolbar threads. No deploys or replies.",
  tools: {
    allow: rootAllow.filter(
      (tool) => !(VERCEL_WRITE_TOOLS as readonly string[]).includes(tool)
    ),
  },
});
