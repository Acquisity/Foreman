import { connect } from "@vercel/connect/eve";
import { requireEnv } from "./constants.js";

/** App-scoped Instantly admin-workspace credential held by Vercel Connect. */
export const instantlyApiAuth = connect({
  connector: requireEnv(
    "INSTANTLY_API_CONNECTOR",
    "api.instantly.ai/acquisity-foreman"
  ),
  principalType: "app",
});
