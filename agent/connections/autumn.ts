import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * The read scopes accepted by this connector's actual OAuth callback, plus the
 * OIDC basics. `offline_access` only enables refresh tokens. Autumn splits
 * read and write into distinct scopes, so the token can read the billing
 * surface Foreman needs and write none of it: writes fail at the API, not just
 * at the tool filter.
 *
 * @remarks
 * Autumn's auth-server metadata advertises more read scopes, but the real
 * authorization callback rejects `rewards:read`, `migrations:read`, and
 * `platform:read` with `invalid_scope`. It did not reject `analytics:read`,
 * but no remaining allowlisted tool needs it and it was not part of the
 * successful Connect grant. The scope set below stays within that actual
 * grant instead of trusting published metadata that this client cannot obtain.
 */
const READ_SCOPES = [
  "openid",
  "offline_access",
  "organisation:read",
  "customers:read",
  "features:read",
  "plans:read",
  "balances:read",
  "billing:read",
];

const AUTUMN_MCP_URL = "https://mcp.useautumn.com/mcp";

/**
 * Autumn MCP connection for what a customer was actually provisioned.
 *
 * @remarks
 * - User-scoped via Vercel Connect (managed MCP registration against
 *   Autumn's auth server at `https://api.useautumn.com/api/auth`); uses the
 *   authorization-code grant with PKCE: a one-time consent stores a refresh
 *   token, after which calls are non-interactive and auto-refreshing, and
 *   tokens are never exposed to the model.
 * - Grants are keyed by a subject Vercel Connect derives from the session
 *   principal. A person can arrive under different subjects from Slack, Linear,
 *   and the CLI, so cross-surface consent coverage is untested here. Do not
 *   assume it without checking.
 *
 *   This is a real gap on the Asks path, not a settled design: a ticket filed
 *   from Slack runs under the AIA requester, who has no Autumn account and
 *   whose channel is intake-only, where {@link userConnect} denies rather than
 *   prompting. Pinning the subject with `createSubject` was tried and reverted:
 *   consent completed and the callback landed, but Connect then reported the
 *   user unauthorized, because the issuer-prefixed subject it was handed is not
 *   where the grant had been stored. Stripe and Intercom have the same gap.
 *   Solve it against a verified mechanism rather than a reasoned-about one.
 * - Read-only twice over. {@link READ_SCOPES} narrows the grant itself, and
 *   the allowlist below narrows what the model can discover, built from the
 *   server's live tool list. That bound is what makes a borrowed grant safe.
 * - `getOrCreateCustomer` is excluded: it reads like a getter and creates on
 *   a miss, so it is a write.
 * - The `preview*` tools compute without applying, confirmed against the
 *   live server, but they exist to stage an attach, a balance grant, a
 *   catalog change, or a subscription update. Billing triage proposes and a
 *   human executes, so none of them are admitted, and the read-only grant
 *   would reject them anyway.
 * - No `denyUnattendedWrites` gate: with writes excluded at the grant, a
 *   later allowlist widening still fails at Autumn's API, and a third copy
 *   of the write-tool list would only drift out of sync with this one.
 * - `resources` carries the RFC 8707 resource indicator. Autumn publishes
 *   protected-resource metadata, which is what obliges a client to bind the
 *   token to the MCP it is for. Whether Autumn rejects an unbound token is
 *   unverified, and it costs nothing if it does not, but the failure mode it
 *   prevents is the one Modem hit: consent succeeds, the auth server calls
 *   the token valid, and every tool call 401s in a way that reads like
 *   Autumn was never connected.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "AUTUMN_MCP_CONNECTOR",
      "mcp.useautumn.com/acquisity-foreman-autumn"
    ),
    principalType: "user",
    tokenParams: { resources: [AUTUMN_MCP_URL], scopes: READ_SCOPES },
  }),
  description:
    "Autumn billing provisioning, read-only: customers, their plans, add-ons, subscriptions and feature balances, the plan and feature catalog, and entities.",
  tools: {
    allow: [
      "dateToEpochMilliseconds",
      "epochMillisecondsToDate",
      "getCurrentOrganization",
      "getCustomer",
      "getEntity",
      "getPlan",
      "listCustomers",
      "listEntities",
      "listFeatures",
      "listPlans",
    ],
  },
  url: AUTUMN_MCP_URL,
});
