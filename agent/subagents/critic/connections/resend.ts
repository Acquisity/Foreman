import { defineMcpClientConnection } from "eve/connections";
import root from "../../../connections/resend.js";
import { withoutConsent } from "../../../lib/user-connect.js";

// Resend's OAuth grants full_access, so the root is read-only only by its
// curated get-*/list-* allowlist. Filtering by that shape here means a write
// tool added to the root later can never reach the critic.
const READ_TOOL_PATTERN = /^(get|list)-/u;
const rootAllow = root.tools && "allow" in root.tools ? root.tools.allow : [];

// The root definition, read-only as authored there, with its user-scoped
// sign-in prompt turned into a terminal failure: a task-mode child cannot
// park on consent. Credential path unchanged.
export default defineMcpClientConnection({
  ...root,
  auth: withoutConsent(root.auth),
  tools: {
    allow: rootAllow.filter((tool) => READ_TOOL_PATTERN.test(tool)),
  },
});
