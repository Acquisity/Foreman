import { connect } from "@vercel/connect/eve";
import { requireEnv } from "./constants.js";

/** App-scoped API-key credentials for billing intake reads. */
export const autumnApiAuth = connect({
  connector: requireEnv(
    "AUTUMN_API_CONNECTOR",
    "api.useautumn.com/acquisity-foreman-autumn-api"
  ),
  principalType: "app",
});

/** App-scoped restricted-key credentials for billing intake reads. */
export const stripeApiAuth = connect({
  connector: requireEnv(
    "STRIPE_API_CONNECTOR",
    "api.stripe.com/acquisity-foreman-stripe-api"
  ),
  principalType: "app",
});
