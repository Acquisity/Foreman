import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
  cleanText,
} from "#lib/investigation-memory/case.js";
import {
  featureForCase,
  NO_FEATURE_REASON,
} from "#lib/investigation-memory/scope.js";
import { correctCase } from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Supersede an earlier investigation case with a corrected conclusion, when later evidence or a trusted human in the thread overturns it. The earlier case is kept and marked superseded, so the history stays readable; it stops appearing in searches and stops counting toward incident signals. Pass the full corrected case, not a patch, with the same source id as the case it replaces; for a ticketless source, name the live product area in `primaryFeatureKey`. Same sanitization rules as recording: the pattern, never the customer.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        reason: "This session is not authorized to write investigation memory.",
        recorded: false as const,
      };
    }

    const feature = featureForCase(input);
    if (feature === null) {
      return {
        reason: NO_FEATURE_REASON,
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
          "That case is not the active revision for its source, so there is nothing to supersede. Search memory again and correct the current case.",
        prior_case_other_ticket:
          "That case belongs to a different source. A correction replaces the active case for this source only. Search memory with this source id to get its own case id and use that.",
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
      "What the new evidence, or the human correcting you, showed that the old conclusion missed."
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
