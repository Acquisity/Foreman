import { defineTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { evidenceDeps, gatherDisputeEvidence } from "#lib/dispute-evidence.js";
import { DISPUTE_ID } from "#lib/stripe-dispute-read.js";
import { disputeAccessRefusal } from "./respond_stripe_dispute.js";

/**
 * Reads every evidence source for one Stripe dispute (ENG-16494). The same
 * access gate as `respond_stripe_dispute` check: denied, never parked, for
 * intake-only, questions-only and delegated sessions.
 */

export const gatherInputSchema = z.object({
  disputeId: z
    .string()
    .describe("The du_ id from the alert's Open in Stripe link."),
});

export const gatherOutputSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  result: z.unknown().optional(),
});

export const gatherDisputeEvidencePolicy = (
  ctx: ApprovalContext
): ApprovalStatus => {
  const reason = disputeAccessRefusal(
    ctx.session.auth,
    "check",
    Boolean(ctx.session.parent)
  );
  return reason ? { reason, type: "denied" } : "not-applicable";
};

export default defineTool({
  approval: gatherDisputeEvidencePolicy,
  description:
    "Read every evidence source for one Stripe dispute, every time, returned in this order: Stripe (dispute, charge with refunds, customer, invoices, subscriptions, other charges, credit notes), the Acquisity database for the billing account's single live workspace (members, sign-up and first session IP, sign-ins, domains, inboxes, orders, campaigns and sends, plan changes, cancellations, support chats, renewal notices), Autumn, Instantly, every Linear ticket the search found, with its text and matchedOn (which of the customer's identifiers it names; empty means it may be about someone else), and the AI Acquisition client channel around the purchase. Stripe runs first, then database and Autumn overlap, followed by concurrent Instantly, Linear and Slack reads, each with its own deadline. A source is checked only when all its required reads succeeded. A failed source has checked false and an error, and may retain partial facts under facts. Use only facts actually returned; missing facts are unverified, not empty. verdict holds refundedInFull, deliveryStoppedBeforeCharge, duplicate, tiedToWorkspace, usedAfterCharge and partialOutageBeforeCharge, each true, false, or null when the facts that decide it could not be read, with the dated facts behind it. Delivery stopped requires a complete outage; partialOutageBeforeCharge carries affected and total counts for rule 4. Stripe chargeInvoice uses a separate invoice read within two days of the charge and reports a unique match or why it is unknown; unwindowed invoice history remains available. Ticket matchedOn distinguishes exact email or id ownership from full workspace or person names. A checked Slack source with channel null means the complete list found no matching channel; channel promises remain unverified. Lists carry truncated when rows or text were cut; proofTruncated marks shortened proof arrays. Incomplete inputs cannot prove a negative. An error means the evidence could not fit the response limit. Read only.",
  async execute({ disputeId }, ctx) {
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason;
    }
    const access = disputeAccessRefusal(
      ctx.session.auth,
      "check",
      Boolean(ctx.session.parent)
    );
    if (access) {
      return { ok: false, reason: access };
    }
    if (!DISPUTE_ID.test(disputeId)) {
      return {
        ok: false,
        reason: "disputeId must be a Stripe dispute id (du_...).",
      };
    }
    const result = await gatherDisputeEvidence(disputeId, evidenceDeps(ctx));
    // A cancelled turn throws; a source that hit the deadline is in the result.
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason;
    }
    return result.error
      ? { ok: false, reason: result.error, result }
      : { ok: true, result };
  },
  inputSchema: gatherInputSchema,
  outputSchema: gatherOutputSchema,
});
