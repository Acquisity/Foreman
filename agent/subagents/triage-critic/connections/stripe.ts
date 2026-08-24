import { defineMcpClientConnection } from "eve/connections";
import stripe, { STRIPE_READ_TOOLS } from "../../../connections/stripe.js";

export default defineMcpClientConnection({
  ...stripe,
  description:
    "Stripe billing evidence, read-only. The inherited user authorization remains in force, and unavailable access is an explicit evidence gap.",
  tools: { allow: [...STRIPE_READ_TOOLS] },
});
