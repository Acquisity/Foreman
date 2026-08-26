import { defineMcpClientConnection } from "eve/connections";
import vercel, { WRITE_TOOLS } from "../../../connections/vercel.js";
import { withoutConsent } from "../../../lib/user-connect.js";

// The root allowlist minus the root's own write list, so a write tool added
// there can never reach the critic. The root approval predicate stays
// attached even though nothing it gates remains.
const rootAllow =
  vercel.tools && "allow" in vercel.tools ? vercel.tools.allow : [];

export default defineMcpClientConnection({
  ...vercel,
  auth: withoutConsent(vercel.auth),
  description:
    "Vercel, read-only: deployments, build and runtime logs, runtime errors, analytics, and toolbar threads. No deploys or replies.",
  tools: {
    allow: rootAllow.filter(
      (tool) => !(WRITE_TOOLS as readonly string[]).includes(tool)
    ),
  },
});
