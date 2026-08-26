import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
} from "#lib/investigation-memory/case.js";
import { featureForCase } from "#lib/investigation-memory/scope.js";
import { recordCase } from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

/**
 * Why a write had no product area to file under. A ticketed case needs a
 * mapped project; a ticketless one needs a live area named directly.
 */
export const NO_FEATURE_REASON =
  "The case has no owning product area, so it is not recorded and the investigation itself stands. A Linear-sourced case needs a project mapped to a product area. A ticketless Intercom or Slack case needs a live product area in primaryFeatureKey.";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Record one settled investigation as a sanitized case: a completed Linear triage, a ticketless Intercom or Slack investigation, or a conclusion a trusted human corrected in the thread. For a Linear ticket, record after the Triage investigation document is attached, the classification is final, and final Linear handling has saved the evidence-backed product project; re-read the issue and pass that resulting project id. For a ticketless source, use `intercom:<conversation id>` or `slack:<channel id>/<thread ts>` as the source id, omit the project id, and name the live product area the evidence points at in `primaryFeatureKey`. When a human overturned an earlier conclusion of yours that was never recorded, record the corrected conclusion here and put the overturned one in `ruledOut`. Store the pattern, not the customer: no email addresses, organization or user ids, raw production rows, logs, or credentials. If a case already exists for this source and the conclusion has changed, use `correct_investigation_case` instead. A failure here never changes the verdict or holds the ticket.",
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
            : "This source already has an active case with a different conclusion. Use correct_investigation_case to supersede it.",
        recorded: false as const,
      };
    } catch (error) {
      console.error("Investigation memory write failed.", error);
      return {
        reason: "The investigation itself stands.",
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
