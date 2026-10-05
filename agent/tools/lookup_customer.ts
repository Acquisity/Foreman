import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  customerEmailSchema,
  lookupCustomer,
  lookupCustomerResultSchema,
  PRODUCTION_READ_QUERY_ARGS,
} from "#lib/lookup-customer.js";
import { callPlanetscaleReadQuery } from "#lib/planetscale.js";

export default defineTool({
  description:
    "Resolve a customer email against production once: the user row, every live workspace membership, and the organization each one belongs to. " +
    "Use pinnedOrganizationId to scope every later PlanetScale query; Autumn and Stripe key on the billing account instead, so read_autumn_billing takes billingAccount.id from read_billing_account, and read_stripe_billing takes the stripe_id on the Autumn record it returns. When ambiguous is true the email belongs to several workspaces, so pick the one the report is about or ask the requester. " +
    "found false with no error means no production user has that email; error set means the lookup could not run, not that the customer is missing. " +
    "Read-only; the query is fixed.",
  execute({ email }, ctx) {
    return lookupCustomer(email, (query) =>
      callPlanetscaleReadQuery(ctx, {
        ...PRODUCTION_READ_QUERY_ARGS,
        query,
      })
    );
  },
  inputSchema: z.object({
    email: customerEmailSchema.describe(
      "The customer's email address from the ticket or conversation."
    ),
  }),
  outputSchema: lookupCustomerResultSchema,
});
