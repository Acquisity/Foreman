import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import { completeMasterReservation } from "#lib/investigation-memory/master-reservation.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Complete a causal master reservation after creating the one Linear master and reading back its identifier and createdAt timestamp successfully. The timestamp preserves the evidence needed for later 30-day eligibility decisions. If completion cannot be confirmed, do not create another master; retain the Linear issue identifier and route the mismatch to a person.",
  async execute({ masterCreatedAt, masterIssueId, reservationId }, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        completed: false as const,
        reason: "This session is not authorized to complete a reservation.",
      };
    }
    try {
      const completed = await completeMasterReservation(
        reservationId,
        masterIssueId,
        masterCreatedAt
      );
      return completed
        ? { completed: true as const }
        : {
            completed: false as const,
            reason:
              "The reservation is absent or already complete. Do not create another master.",
          };
    } catch {
      return {
        completed: false as const,
        reason:
          "The reservation completion could not be confirmed. Do not create another master.",
      };
    }
  },
  inputSchema: z.object({
    masterCreatedAt: z.iso.datetime(),
    masterIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
    reservationId: z.uuid(),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    reason: z.string().optional(),
  }),
});
