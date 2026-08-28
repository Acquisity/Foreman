import { defineTool } from "eve/tools";
import { z } from "zod";
import { planetscaleAuth } from "#lib/constants.js";
import {
  customerEmailSchema,
  lookupCustomer,
  lookupCustomerResultSchema,
  PRODUCTION_READ_QUERY_ARGS,
} from "#lib/lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
} from "#lib/planetscale.js";

export default defineTool({
  description:
    "Resolve a customer email against production once: the user row, every live workspace membership, and the organization each one belongs to. " +
    "Use pinnedOrganizationId to scope every later PlanetScale query; Autumn and Stripe key on the billing account instead, so read_autumn_billing takes billingAccount.id from read_billing_account, and read_stripe_billing takes the stripe_id on the Autumn record it returns. When ambiguous is true the email belongs to several workspaces, so pick the one the report is about or ask the requester. " +
    "found false with no error means no production user has that email; error set means the lookup could not run, not that the customer is missing. " +
    "Read-only; the query is fixed.",
  async execute({ email }, ctx) {
    const { token } = await ctx.getToken(planetscaleAuth);
    return lookupCustomer(email, async (query) => {
      try {
        return await callPlanetscaleReadQuery(token, {
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        });
      } catch (error) {
        // A grant revoked mid-flight surfaces as a downstream 401/403; re-challenge
        // so eve evicts the dead bearer and mints a fresh token.
        if (
          error instanceof PlanetscaleHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          ctx.requireAuth(planetscaleAuth);
        }
        throw error;
      }
    });
  },
  inputSchema: z.object({
    email: customerEmailSchema.describe(
      "The customer's email address from the ticket or conversation."
    ),
  }),
  outputSchema: lookupCustomerResultSchema,
});
