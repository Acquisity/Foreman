import { httpBasic } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";
import { requireEnv } from "../lib/constants.js";

/**
 * MCP channel: publishes Foreman at `/eve/v1/mcp` so clients like Claude Code
 * can delegate durable work through `agent_start`, `agent_get`,
 * `agent_update`, and `agent_cancel`.
 *
 * @remarks
 * One shared HTTP Basic credential from `MCP_BASIC_USER` and
 * `MCP_BASIC_PASSWORD`, in development as well as production. `localDev()` is
 * deliberately not in the walk: it would resolve a second, dev-only principal,
 * and a principal is a Vercel Connect grant subject. Every user-scoped
 * connection consents per subject, so a channel with two principals needs two
 * consent rounds and drifts between them. One credential everywhere means the
 * consent granted from `pnpm dev` is the same grant production uses.
 *
 * `httpBasic()` resolves `principalType: "user"` with `principalId` set to the
 * configured username, which is what the user-scoped connectors and the
 * user-preference tools expect. It never resolves an app principal against a
 * user-only connector, the mismatch that fails terminally.
 *
 * That principal is new to Connect, so the first invocation reaching a
 * user-scoped connection returns `authorization_required` with a consent URL
 * rather than working. That is the designed path: the client presents the URL,
 * the callback resumes the invocation, and the grant persists for later
 * invocations. Approvals arrive the same way, as `input_required` answered
 * through `agent_update`.
 *
 * The credential is shared, not per person, so callers are not stamped
 * trusted: an MCP turn has the standing of an untrusted commenter and cannot
 * write repository knowledge, model settings, or non-GitHub connections. Split
 * this into one strategy per teammate before widening that.
 *
 * There is no dispatch hook here to stamp a repository, so an MCP message
 * doing repository work must name exactly one `owner/repo` or GitHub URL in
 * its text, the same rule as any other eve request.
 */
/**
 * The Basic username, and so the `principalId` every MCP session runs under.
 *
 * @remarks
 * Fixed in code rather than read from the environment. It is the Vercel
 * Connect grant subject, so changing it orphans every consent granted to the
 * previous value, and an environment variable set to an empty string would
 * resolve an empty `principalId` that authenticates but fails every
 * user-scoped tool. A value that must never vary is not configuration.
 */
const MCP_USERNAME = "foreman-mcp";

export default mcpChannel({
  auth: httpBasic({
    password: requireEnv("MCP_BASIC_PASSWORD", "a long random shared secret"),
    username: MCP_USERNAME,
  }),
});
