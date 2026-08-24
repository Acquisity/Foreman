import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  findTriageReviewVerdict,
  triageReviewApprovalIdSchema,
} from "#lib/triage-review-attestation.js";
import { evidenceRevisionSchema } from "#lib/triage-review-packet.js";
import { readVerifiedTriageReviewPacket } from "#lib/triage-review-packet-file.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  description:
    "Read the server-attested result of an actual completed triage-critic review for one evidence revision. Only an APPROVE result returns the opaque approval ID accepted by downstream Bug memory and master-reservation tools. A missing result means the review was invalid, not completed, or could not be attested; never fabricate an approval.",
  async execute({ evidenceRevision }, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return { available: false as const };
    }
    try {
      const packet = await readVerifiedTriageReviewPacket(
        await ctx.getSandbox(),
        evidenceRevision
      );
      if (!packet.verified) {
        return { available: false as const };
      }
      const result = await findTriageReviewVerdict(
        ctx.session.id,
        packet.packet,
        evidenceRevision
      );
      return result
        ? {
            approvalId:
              result.verdict === "APPROVE" ? result.approvalId : undefined,
            available: true as const,
            reviewAttempt: result.attempt,
            reviewerModel: result.reviewerModel,
            verdict: result.verdict,
          }
        : { available: false as const };
    } catch {
      return { available: false as const };
    }
  },
  inputSchema: z.object({ evidenceRevision: evidenceRevisionSchema }),
  outputSchema: z.object({
    approvalId: triageReviewApprovalIdSchema.optional(),
    available: z.boolean(),
    reviewAttempt: z.union([z.literal(1), z.literal(2)]).optional(),
    reviewerModel: z.string().optional(),
    verdict: z
      .enum(["APPROVE", "CHALLENGE", "INSUFFICIENT_EVIDENCE"])
      .optional(),
  }),
});
