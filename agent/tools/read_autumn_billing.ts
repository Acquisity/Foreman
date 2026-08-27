import { defineTool } from "eve/tools";
import { z } from "zod";
import { readAutumnCustomer } from "#lib/billing-api.js";
import { autumnApiAuth } from "#lib/billing-api-auth.js";
import { canUseBillingApiRead } from "#lib/trust.js";

export default defineTool({
  description:
    "Read one existing Autumn billing customer by the customer or organization id already verified in PlanetScale. Available in any configured intake-only channel. This never creates a customer or changes billing. When available is false, record Autumn as unverified rather than treating it as empty.",
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
        "The existing Autumn customer id, usually the organization id verified in PlanetScale."
      ),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
  }),
});
