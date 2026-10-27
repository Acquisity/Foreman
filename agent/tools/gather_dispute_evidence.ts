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
    "Read every evidence source for one Stripe dispute, in a fixed order, every time: Stripe (dispute, charge with refunds, customer, invoices, subscriptions, other charges, credit notes), the Acquisity database for the workspace this charge provisioned (members, sign-up and first session IP, sign-ins, domains, inboxes, orders, campaigns and sends, plan changes, cancellations, support chats, renewal notices), Autumn, Instantly, Linear tickets with their text, and the AI Acquisition client channel around the purchase. Each source comes back checked with its facts, or checked false with an error: a failed source is unverified, not empty. verdict holds refundedInFull, deliveryStoppedBeforeCharge, duplicate, tiedToWorkspace and usedAfterCharge, each true, false, or null when the facts that decide it could not be read, with the dated facts behind it. Lists carry a truncated flag when a limit cut them. Read only.",
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
    return { ok: true, result };
  },
  inputSchema: gatherInputSchema,
  outputSchema: gatherOutputSchema,
});
