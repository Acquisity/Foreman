import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  evidenceRevisionSchema,
  triageReviewPacketSchema,
} from "#lib/triage-review-packet.js";
import { readVerifiedTriageReviewPacket } from "#lib/triage-review-packet-file.js";

export default defineTool({
  description:
    "Read and verify one immutable triage review packet by its evidence revision. Also verifies that the shared prepared repository still matches the packet's repository and exact commit SHA. Treat any unavailable or mismatched result as insufficient evidence.",
  async execute({ evidenceRevision }, ctx) {
    const result = await readVerifiedTriageReviewPacket(
      await ctx.getSandbox(),
      evidenceRevision
    );
    return result.verified
      ? {
          available: true as const,
          packet: result.packet,
          repositoryRevisionMatches: true,
        }
      : { available: false as const, reason: result.reason };
  },
  inputSchema: z.object({ evidenceRevision: evidenceRevisionSchema }),
  outputSchema: z.object({
    available: z.boolean(),
    packet: triageReviewPacketSchema.optional(),
    reason: z.string().optional(),
    repositoryRevisionMatches: z.boolean().optional(),
  }),
});
