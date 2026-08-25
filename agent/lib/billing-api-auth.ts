import { requireEnv } from "./constants.js";
import { managedConnect } from "./managed-connect.js";

/** Required app-scoped API-key credentials for billing and Intercom intake reads. */
export const autumnApiAuth = managedConnect({
  connector: requireEnv(
    "AUTUMN_API_CONNECTOR",
    "api.useautumn.com/acquisity-foreman-autumn-api"
  ),
  principalType: "app",
});

/** Required app-scoped restricted-key credentials for billing and Intercom intake reads. */
export const stripeApiAuth = managedConnect({
  connector: requireEnv(
    "STRIPE_API_CONNECTOR",
    "api.stripe.com/acquisity-foreman-stripe-api"
  ),
  principalType: "app",
});
