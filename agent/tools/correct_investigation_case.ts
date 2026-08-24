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
import {
  approvalMatchesBugCaseContent,
  approvalMatchesSource,
  claimApprovalForMemory,
  type VerifiedTriageApproval,
  verifyTriageApproval,
} from "#lib/triage-review-approval.js";
import { triageReviewApprovalIdSchema } from "#lib/triage-review-attestation.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Supersede an earlier investigation case with a corrected, settled conclusion when later evidence overturns it. The earlier case is kept and marked superseded, so the history stays readable; it stops appearing in searches and stops counting toward incident signals. Pass the full corrected case, not a patch. A corrected Bug requires the opaque criticApprovalId from a server-attested completed review of the exact current evidence revision; this tool verifies it against the packet and corrected case. Same sanitization rules as recording: the pattern, never the customer.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        reason: "This session is not authorized to write investigation memory.",
        recorded: false as const,
      };
    }

    try {
      let verifiedBug: VerifiedTriageApproval | null = null;
      if (input.classification === "bug") {
        if (input.criticApprovalId === undefined) {
          return {
            reason:
              "A corrected Bug case requires an opaque critic approval ID.",
            recorded: false as const,
          };
        }
        const verified = await verifyTriageApproval(
          await ctx.getSandbox(),
          ctx.session.id,
          input.criticApprovalId
        );
        if (
          verified === null ||
          !approvalMatchesBugCaseContent(verified, input)
        ) {
          return {
            reason:
              "The opaque critic approval is absent, not APPROVE, or does not match this exact corrected Bug claim, root cause, confidence, packet, model, and repository revision.",
            recorded: false as const,
          };
        }
        verifiedBug = verified;
      }

      const feature = featureForProject(input.linearProjectId);
      if (feature === null) {
        return {
          reason:
            "That Linear project is not mapped to a product area, so there is no scope to file the correction under.",
          recorded: false as const,
        };
      }
      const result = await correctCase(
        feature,
        input,
        input.classification,
        input.supersedesCaseId,
        input.correctionReason,
        {
          authorizeWrite:
            verifiedBug === null
              ? undefined
              : async () =>
                  (await approvalMatchesSource(
                    verifiedBug,
                    input.sourceIssueId,
                    input.linearProjectId
                  )) &&
                  (await claimApprovalForMemory(verifiedBug, input, "correct", {
                    correctionReason: input.correctionReason,
                    supersedesCaseId: input.supersedesCaseId,
                  })),
        }
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
        authorization_failed:
          "This critic approval is already bound to different memory content.",
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
  inputSchema: casePayloadSchema
    .extend({
      classification: z.enum(CLASSIFICATIONS),
      correctionReason: cleanText(500).describe(
        "What the new evidence showed that the old conclusion missed."
      ),
      criticApprovalId: triageReviewApprovalIdSchema.optional(),
      supersedesCaseId: z
        .uuid()
        .describe("The `caseId` of the active case this replaces."),
    })
    .superRefine((input, ctx) => {
      if (
        input.classification === "bug" &&
        input.criticApprovalId === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "A corrected Bug case requires triage-critic APPROVE for the exact current evidence revision.",
          path: ["criticApprovalId"],
        });
      }
    }),
  outputSchema: z.object({
    caseId: z.string().optional(),
    reason: z.string().optional(),
    recorded: z.boolean(),
    revision: z.number().optional(),
    supersededCaseId: z.string().optional(),
  }),
});
