import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";
import { userConnect } from "../lib/user-connect.js";

/**
 * Every read scope PostHog's MCP resource publishes
 * (`/.well-known/oauth-protected-resource`), plus the OIDC basics. The
 * token can read everything and write nothing — writes are excluded by
 * scope, not by tool filtering.
 */
const READ_SCOPES = [
  "openid",
  "profile",
  "email",
  "action:read",
  "account:read",
  "activity_log:read",
  "alert:read",
  "annotation:read",
  "approvals:read",
  "batch_export:read",
  "business_knowledge:read",
  "canvas:read",
  "cohort:read",
  "comment:read",
  "customer_analytics:read",
  "data_catalog:read",
  "dashboard:read",
  "dashboard_template:read",
  "dataset:read",
  "early_access_feature:read",
  "endpoint:read",
  "engineering_analytics:read",
  "error_tracking:read",
  "evaluation:read",
  "element:read",
  "event_definition:read",
  "experiment:read",
  "experiment_holdout:read",
  "experiment_saved_metric:read",
  "external_data_source:read",
  "feature_flag:read",
  "group:read",
  "health_issue:read",
  "heatmap:read",
  "hog_flow:read",
  "hog_function:read",
  "insight:read",
  "integration:read",
  "llm_analytics:read",
  "llm_prompt:read",
  "llm_provider_key:read",
  "llm_skill:read",
  "logs:read",
  "loop:read",
  "marketing_analytics:read",
  "mcp_analytics:read",
  "metrics:read",
  "notebook:read",
  "organization:read",
  "organization_member:read",
  "person:read",
  "project:read",
  "property_definition:read",
  "query:read",
  "replay_scanner:read",
  "review_hog:read",
  "session_recording:read",
  "session_recording_playlist:read",
  "signal_scout:read",
  "stamphog:read",
  "streamlit_app:read",
  "subscription:read",
  "survey:read",
  "tagger:read",
  "ticket:read",
  "task:read",
  "tracing:read",
  "field_note:read",
  "usage_metric:read",
  "user:read",
  "user_interview:read",
  "vision_action:read",
  "visual_review:read",
  "warehouse_table:read",
  "warehouse_view:read",
  "web_analytics:read",
];

/**
 * PostHog MCP connection for product analytics evidence.
 *
 * @remarks
 * - User-scoped via Vercel Connect against PostHog's US cloud (Acquisity's
 *   region — `us.i.posthog.com`); uses the authorization-code grant: a
 *   one-time consent stores a refresh token, after which calls are
 *   non-interactive and auto-refreshing, and tokens are never exposed to
 *   the model. Available to every session, unattended runs
 *   included.
 * - Read-only by OAuth scope: {@link READ_SCOPES} requests every `:read`
 *   scope and no writes, so write tools fail at the API even if exposed.
 * - PostHog's token endpoint rejects `private_key_jwt` clients ("Unable to
 *   determine region"); the connector's Token Auth Method must be `none`
 *   (public client + PKCE), set in the Connect dashboard after creation.
 */
export default defineMcpClientConnection({
  auth: userConnect({
    connector: requireEnv(
      "POSTHOG_MCP_CONNECTOR",
      "posthog/acquisity-foreman-posthog"
    ),
    principalType: "user",
    tokenParams: { scopes: READ_SCOPES },
  }),
  description:
    "PostHog product analytics, read-only: events, insights, funnels, session recordings, error tracking, feature flags, and experiments.",
  url: "https://mcp.posthog.com/mcp",
});
