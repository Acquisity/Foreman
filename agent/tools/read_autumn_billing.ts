import { defineTool } from "eve/tools";
import { z } from "zod";
import { readAutumnCustomer } from "#lib/billing-api.js";
import { autumnApiAuth } from "#lib/billing-api-auth.js";
import { canUseBillingApiRead } from "#lib/trust.js";

export default defineTool({
  description:
    "Read one existing Autumn billing customer. The Autumn customer id is billingAccount.id from read_billing_account, never pinnedOrganizationId: Acquisity keys Autumn customers by billing account. The result's stripe_id is the cus_ id read_stripe_billing needs. Available on every surface. This never creates a customer or changes billing. When available is false, record Autumn as unverified rather than treating it as empty; a 404 reason means the id was wrong, so re-resolve it, unless organization.partnerGoverned is true: a partner-governed account has no customer in Acquisity's own Autumn.",
  async execute({ customerId }, ctx) {
    if (!canUseBillingApiRead(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason: "This session is not authorized for app-scoped billing reads.",
      };
    }
    try {
      const { token } = await ctx.getToken(autumnApiAuth);
      return {
        available: true as const,
        data: await readAutumnCustomer(token, customerId, {
          signal: ctx.abortSignal,
        }),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      console.error("Autumn billing read failed.", error);
      return {
        available: false as const,
        reason:
          error instanceof Error ? error.message : "Autumn read could not run.",
      };
    }
  },
  inputSchema: z.object({
    customerId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_:-]+$/u)
      .describe(
        "billingAccount.id from read_billing_account. Not the organization id: that returns customer_not_found."
      ),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
  }),
});
