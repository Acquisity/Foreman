import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  billingAccountResultSchema,
  organizationIdSchema,
  readBillingAccount,
} from "#lib/billing-account.js";
import { planetscaleAuth } from "#lib/constants.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
} from "#lib/planetscale.js";

export default defineTool({
  description:
    "The production system-of-record read for a billing ticket, by the organization id pinned by lookup_customer: the organization with its partnerId, the billing account with provider, subscription status and plan, trial dates, and every wallet (credits, domains, inboxes, website credits, each with balance and lifetime purchased, granted, used), the credit_balance rows, and the last 20 credit transactions and manual credits. " +
    "Read partnerId before routing on provider: a partner-governed organization follows the partner rule. Read-only, fixed queries; truncated flags say a history list hit its cap; unavailable names a list whose read failed, so treat it as unverified rather than empty. error means the organization read itself could not run.",
  async execute({ organizationId }, ctx) {
    const { token } = await ctx.getToken(planetscaleAuth);
    return readBillingAccount(organizationId, async (query) => {
      try {
        return await callPlanetscaleReadQuery(token, {
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        });
      } catch (error) {
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
    organizationId: organizationIdSchema.describe(
      "The pinnedOrganizationId from lookup_customer."
    ),
  }),
  outputSchema: billingAccountResultSchema,
});
