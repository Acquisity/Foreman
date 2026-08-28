import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  readStripeCharge,
  readStripeCoupon,
  readStripeCustomerBilling,
  readStripeDispute,
  readStripePromotionCode,
  readStripeRefund,
  stripeLookupSchema,
} from "#lib/billing-api.js";
import { stripeApiAuth } from "#lib/billing-api-auth.js";
import { canUseBillingApiRead } from "#lib/trust.js";

export default defineTool({
  description:
    "Read Stripe billing evidence using the restricted app key, available on every surface. Use customer with the cus_ id from the Autumn record's stripe_id for a bounded bundle of customer, subscription, invoice, charge, credit-note, and balance history; charge, refund, or dispute for a known Stripe object; promotion_code for a customer-facing coupon code; or coupon for a known coupon id. This never changes billing. A per-section error or has_more value means that section is unverified, not empty.",
  async execute(input, ctx) {
    if (!canUseBillingApiRead(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason: "This session is not authorized for app-scoped billing reads.",
      };
    }
    try {
      const { token } = await ctx.getToken(stripeApiAuth);
      const options = { signal: ctx.abortSignal };
      // stripeLookupSchema guarantees the id field for the chosen lookup.
      let data: unknown;
      if (input.lookup === "customer") {
        data = await readStripeCustomerBilling(
          token,
          input.customerId ?? "",
          options
        );
      } else if (input.lookup === "promotion_code") {
        data = await readStripePromotionCode(token, input.code ?? "", options);
      } else if (input.lookup === "coupon") {
        data = await readStripeCoupon(token, input.couponId ?? "", options);
      } else if (input.lookup === "charge") {
        data = await readStripeCharge(token, input.chargeId ?? "", options);
      } else if (input.lookup === "refund") {
        data = await readStripeRefund(token, input.refundId ?? "", options);
      } else {
        data = await readStripeDispute(token, input.disputeId ?? "", options);
      }
      return { available: true as const, data };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      console.error("Stripe billing read failed.", error);
      return {
        available: false as const,
        reason:
          error instanceof Error ? error.message : "Stripe read could not run.",
      };
    }
  },
  inputSchema: stripeLookupSchema,
  outputSchema: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
  }),
});
