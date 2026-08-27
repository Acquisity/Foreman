import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  readStripeCharge,
  readStripeCoupon,
  readStripeCustomerBilling,
  readStripeDispute,
  readStripePromotionCode,
  readStripeRefund,
} from "#lib/billing-api.js";
import { stripeApiAuth } from "#lib/billing-api-auth.js";
import { canUseBillingApiRead } from "#lib/trust.js";

const identifier = z.string().trim().min(1).max(128);
const inputSchema = z.discriminatedUnion("lookup", [
  z.object({
    customerId: identifier.regex(/^cus_[A-Za-z0-9]+$/u),
    lookup: z.literal("customer"),
  }),
  z.object({
    code: identifier,
    lookup: z.literal("promotion_code"),
  }),
  z.object({
    couponId: identifier,
    lookup: z.literal("coupon"),
  }),
  z.object({
    chargeId: identifier.regex(/^ch_[A-Za-z0-9]+$/u),
    lookup: z.literal("charge"),
  }),
  z.object({
    lookup: z.literal("refund"),
    refundId: identifier.regex(/^re_[A-Za-z0-9]+$/u),
  }),
  z.object({
    disputeId: identifier.regex(/^du_[A-Za-z0-9]+$/u),
    lookup: z.literal("dispute"),
  }),
]);

export default defineTool({
  description:
    "Read Stripe billing evidence using the restricted app key, available in any configured intake-only channel. Use customer for a bounded bundle of customer, subscription, invoice, charge, credit-note, and balance history; charge, refund, or dispute for a known Stripe object; promotion_code for a customer-facing coupon code; or coupon for a known coupon id. This never changes billing. A per-section error or has_more value means that section is unverified, not empty.",
  async execute(input, ctx) {
    if (!canUseBillingApiRead(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason: "This session is not authorized for app-scoped billing reads.",
      };
    }
    try {
      const { token } = await ctx.getToken(stripeApiAuth);
      let data: unknown;
      if (input.lookup === "customer") {
        data = await readStripeCustomerBilling(token, input.customerId, {
          signal: ctx.abortSignal,
        });
      } else if (input.lookup === "promotion_code") {
        data = await readStripePromotionCode(token, input.code, {
          signal: ctx.abortSignal,
        });
      } else if (input.lookup === "coupon") {
        data = await readStripeCoupon(token, input.couponId, {
          signal: ctx.abortSignal,
        });
      } else if (input.lookup === "charge") {
        data = await readStripeCharge(token, input.chargeId, {
          signal: ctx.abortSignal,
        });
      } else if (input.lookup === "refund") {
        data = await readStripeRefund(token, input.refundId, {
          signal: ctx.abortSignal,
        });
      } else {
        data = await readStripeDispute(token, input.disputeId, {
          signal: ctx.abortSignal,
        });
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
  inputSchema,
  outputSchema: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
  }),
});
