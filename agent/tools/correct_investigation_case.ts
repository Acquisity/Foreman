import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
  cleanText,
} from "#lib/investigation-memory/case.js";
import { featureForProject } from "#lib/investigation-memory/scope.js";
import { correctCase } from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Supersede an earlier investigation case with a corrected conclusion, when later evidence overturns it. The earlier case is kept and marked superseded, so the history stays readable; it stops appearing in searches and stops counting toward incident signals. Pass the full corrected case, not a patch. Same sanitization rules as recording: the pattern, never the customer.",
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
          "That Linear project is not mapped to a product area, so there is no scope to file the correction under.",
        recorded: false as const,
      };
    }

    try {
      const result = await correctCase(
        feature,
        input,
        input.classification,
        input.supersedesCaseId,
        input.correctionReason
      );
      if (result.created) {
        return {
          caseId: result.caseId,
          recorded: true as const,
          revision: result.revision,
          supersededCaseId: result.supersededCaseId,
        };
      }
      const reasons = {
        already_recorded:
          "This correction is already recorded. Nothing changed.",
        prior_case_not_active:
          "That case is not the active revision for its ticket, so there is nothing to supersede. Search memory again and correct the current case.",
        prior_case_other_ticket:
          "That case belongs to a different ticket. A correction replaces the active case for this ticket only. Search memory for this ticket's own case id and use that.",
      } as const;
      return {
        caseId: "caseId" in result ? result.caseId : undefined,
        reason: reasons[result.reason],
        recorded: false as const,
      };
    } catch (error) {
      console.error("Investigation memory correction failed.", error);
      return {
        reason:
          "The correction could not be confirmed. Search again before retrying.",
        recorded: false as const,
      };
    }
  },
  inputSchema: casePayloadSchema.extend({
    classification: z.enum(CLASSIFICATIONS),
    correctionReason: cleanText(500).describe(
      "What the new evidence showed that the old conclusion missed."
    ),
    supersedesCaseId: z
      .uuid()
      .describe("The `caseId` of the active case this replaces."),
  }),
  outputSchema: z.object({
    caseId: z.string().optional(),
    reason: z.string().optional(),
    recorded: z.boolean(),
    revision: z.number().optional(),
    supersededCaseId: z.string().optional(),
  }),
});
