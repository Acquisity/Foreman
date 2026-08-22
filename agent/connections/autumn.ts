import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Every read scope Autumn's MCP resource and auth server publish, plus the
 * OIDC basics. `offline_access` only enables refresh tokens. Autumn splits
 * read and write into distinct scopes, so the token can read the whole
 * billing surface and write none of it: writes fail at the API, not just at
 * the tool filter.
 *
 * @remarks
 * Taken from the auth server's `/.well-known/oauth-authorization-server`, not
 * from the MCP resource metadata, which is incomplete: it omits `rewards:read`
 * even though `listRewards` needs it. Since that mapping cannot be trusted,
 * every read scope the connector grants is requested rather than the subset
 * the allowlist looks like it needs. `migrations:read` and `platform:read` are
 * the tools whose backing scope is not deducible (`getAgentRules`,
 * `queryRequestLogs`, `searchRequestLogs`), and guessing wrong would 403 at
 * call time in a way that reads like the customer having no data. Breadth here
 * costs nothing: the point is that no scope is a write, not that reads are
 * minimal.
 */
const READ_SCOPES = [
  "openid",
  "offline_access",
  "organisation:read",
  "customers:read",
  "features:read",
  "plans:read",
  "rewards:read",
  "balances:read",
  "billing:read",
  "migrations:read",
  "analytics:read",
  "platform:read",
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
 * - Grants are per principal, not per person. Vercel Connect keys a stored
 *   grant by a subject it derives from the session principal, and a person
 *   arrives under a different one on each surface (`slack:<team>:<user>` from
 *   Slack, `linear:<user>` from a Linear agent session, their Vercel account
 *   from the CLI). Consent is needed once per surface someone reads Autumn
 *   from, not once per person.
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
    "Autumn billing provisioning, read-only: customers, their plans, add-ons, subscriptions and feature balances, the plan and feature catalog, entities, rewards, and request logs.",
  tools: {
    allow: [
      "dateToEpochMilliseconds",
      "epochMillisecondsToDate",
      "getAgentRules",
      "getCurrentOrganization",
      "getCustomer",
      "getEntity",
      "getPlan",
      "listCustomers",
      "listEntities",
      "listFeatures",
      "listPlans",
      "listRewards",
      "queryRequestLogs",
      "searchRequestLogs",
    ],
  },
  url: AUTUMN_MCP_URL,
});
