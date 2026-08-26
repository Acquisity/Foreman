import { defineMcpClientConnection } from "eve/connections";
import root from "../../../connections/modem.js";
import { withoutConsent } from "../../../lib/user-connect.js";

// The root definition, read-only as authored there, with its user-scoped
// sign-in prompt turned into a terminal failure: a task-mode child cannot
// park on consent. Credential path unchanged.
export default defineMcpClientConnection({
  ...root,
  auth: withoutConsent(root.auth),
});
