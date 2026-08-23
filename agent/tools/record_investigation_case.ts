import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
} from "#lib/investigation-memory/case.js";
import { featureForProject } from "#lib/investigation-memory/scope.js";
import { recordCase } from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Record one completed triage investigation as a sanitized case, after the Triage investigation document is attached and the classification is final. The product area comes from the ticket's Linear project, never from the symptom. Store the pattern, not the customer: no email addresses, organization or user ids, raw production rows, logs, or credentials. If a case already exists for this ticket and the conclusion has changed, use `correct_investigation_case` instead. A failure here never changes the verdict or holds the ticket.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        reason: "This session is not authorized to write investigation memory.",
        recorded: false as const,
      };
    }

    const feature = featureForProject(input.linearProjectId);
    if (feature === null) {
      return {
        reason:
          "That Linear project is not mapped to a product area, so the case has no owning feature and is not recorded. The investigation itself stands.",
        recorded: false as const,
      };
    }

    try {
      const result = await recordCase(feature, input, input.classification);
      if (result.created) {
        return {
          caseId: result.caseId,
          primaryFeatureKey: feature,
          recorded: true as const,
          revision: result.revision,
        };
      }
      return {
        caseId: "caseId" in result ? result.caseId : result.existingCaseId,
        reason:
          result.reason === "already_recorded"
            ? "This exact conclusion is already recorded. Nothing changed."
            : "This ticket already has an active case with a different conclusion. Use correct_investigation_case to supersede it.",
        recorded: false as const,
      };
    } catch (error) {
      console.error("Investigation memory write failed.", error);
      return {
        reason:
          "Investigation memory was unavailable. The investigation itself stands.",
        recorded: false as const,
      };
    }
  },
  inputSchema: casePayloadSchema.extend({
    classification: z
      .enum(CLASSIFICATIONS)
      .describe(
        "The final Step 4.6 verdict. Use `unproven` only when the evidence genuinely left the claim open."
      ),
  }),
  outputSchema: z.object({
    caseId: z.string().optional(),
    primaryFeatureKey: z.string().optional(),
    reason: z.string().optional(),
    recorded: z.boolean(),
    revision: z.number().optional(),
  }),
});
