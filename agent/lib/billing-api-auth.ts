import { connect } from "@vercel/connect/eve";
import { requireEnv } from "./constants.js";

/** Required app-scoped API-key credentials for billing and Intercom intake reads. */
export const autumnApiAuth = connect({
  connector: requireEnv(
    "AUTUMN_API_CONNECTOR",
    "api.useautumn.com/acquisity-foreman-autumn-api"
  ),
  principalType: "app",
});

/** Required app-scoped restricted-key credentials for billing and Intercom intake reads. */
export const stripeApiAuth = connect({
  connector: requireEnv(
    "STRIPE_API_CONNECTOR",
    "api.stripe.com/acquisity-foreman-stripe-api"
  ),
  principalType: "app",
});
