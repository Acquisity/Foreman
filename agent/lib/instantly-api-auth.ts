import { requireEnv } from "./constants.js";
import { managedConnect } from "./managed-connect.js";

/** App-scoped Instantly admin-workspace credential held by Vercel Connect. */
export const instantlyApiAuth = managedConnect({
  connector: requireEnv(
    "INSTANTLY_API_CONNECTOR",
    "api.instantly.ai/acquisity-foreman"
  ),
  principalType: "app",
});
