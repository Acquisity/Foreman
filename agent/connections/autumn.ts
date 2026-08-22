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
 * `rewards:read` is published by the auth server
 * (`/.well-known/oauth-authorization-server`) but not by the MCP resource
 * metadata; `listRewards` needs it.
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
  "analytics:read",
];

/**
 * Autumn MCP connection for what a customer was actually provisioned.
 *
 * @remarks
 * - User-scoped via Vercel Connect (managed MCP registration against
 *   Autumn's auth server at `https://api.useautumn.com/api/auth`); uses the
 *   authorization-code grant with PKCE: a one-time consent stores a refresh
 *   token, after which calls are non-interactive and auto-refreshing, and
 *   tokens are never exposed to the model. Every teammate needs that consent
 *   once before Autumn answers in their sessions.
 * - Read-only twice over. {@link READ_SCOPES} narrows the grant itself, and
 *   the allowlist below narrows what the model can discover, built from the
 *   server's live tool list.
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
const AUTUMN_MCP_URL = "https://mcp.useautumn.com/mcp";

/**
 * The one Autumn grant every session borrows, as `<issuer>|<id>` matching the
 * principal that consented (a Slack principal is `slack:<team>|slack:<team>:<user>`).
 *
 * @remarks
 * Vercel Connect stores a grant per subject and derives that subject from the
 * session principal, so by default an Asks ticket looks up a grant belonging to
 * the AIA requester who typed the slash command. They have no Autumn account
 * and their channel is intake-only, where {@link userConnect} denies a missing
 * grant outright rather than showing a consent card nobody there can complete.
 * Autumn would fail on every ticket it exists to answer.
 *
 * Pinning the subject makes one operator's consent serve every session, and
 * eve refreshes that grant on its own from then on. The connection stays
 * read-only, so what a borrowed grant can do is bounded by the token's scopes.
 *
 * Unset, the connection falls back to per-user grants and behaves like Stripe
 * and Intercom, which have the same gap on this path and are not fixed here.
 */
const SHARED_GRANT = process.env.AUTUMN_GRANT_SUBJECT?.split("|");

export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "AUTUMN_MCP_CONNECTOR",
      "mcp.useautumn.com/acquisity-foreman-autumn"
    ),
    createSubject: (principal) => {
      const [issuer, id] = SHARED_GRANT ?? [];
      if (issuer !== undefined && id !== undefined) {
        return { id, issuer, type: "user" };
      }
      return principal.type === "user"
        ? { id: principal.id, issuer: principal.issuer, type: "user" }
        : { type: "app" };
    },
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
