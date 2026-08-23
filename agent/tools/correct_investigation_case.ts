import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
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
      return {
        caseId: "caseId" in result ? result.caseId : undefined,
        reason:
          result.reason === "already_recorded"
            ? "This correction is already recorded. Nothing changed."
            : "That case is not the active revision for its ticket, so there is nothing to supersede. Search memory again and correct the current case.",
        recorded: false as const,
      };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : "Correction failed.",
        recorded: false as const,
      };
    }
  },
  inputSchema: casePayloadSchema.extend({
    classification: z.enum(CLASSIFICATIONS),
    correctionReason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What the new evidence showed that the old conclusion missed."),
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
