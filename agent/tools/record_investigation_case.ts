import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  CLASSIFICATIONS,
  casePayloadSchema,
} from "#lib/investigation-memory/case.js";
import { featureForProject } from "#lib/investigation-memory/scope.js";
import { recordCase } from "#lib/investigation-memory/store.js";
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
    "Record one settled triage investigation as a sanitized case after the Triage investigation document and final external writes are complete. A Bug is final only when an actual completed triage-critic review was server-attested for the exact current evidence revision. Pass the opaque criticApprovalId returned by read_triage_review_verdict; this tool verifies the source issue, project, claim, cause, confidence, repository commit, code paths, and dated impact against the reviewed packet, then binds the approval to this exact memory payload. The product area comes from the ticket's Linear project, never from the symptom. Store the pattern, not the customer: no email addresses, organization or user ids, raw production rows, logs, or credentials. If a case already exists for this ticket and the conclusion has changed, use `correct_investigation_case` instead. A failure here never changes the verdict or holds the ticket.",
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
            reason: "A Bug case requires an opaque critic approval ID.",
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
              "The opaque critic approval is absent, not APPROVE, or does not match this exact Bug claim, root cause, confidence, packet, model, and repository revision.",
            recorded: false as const,
          };
        }
        verifiedBug = verified;
      }

      const feature = featureForProject(input.linearProjectId);
      if (feature === null) {
        return {
          reason:
            "That Linear project is not mapped to a product area, so the case has no owning feature and is not recorded. The investigation itself stands.",
          recorded: false as const,
        };
      }
      const result = await recordCase(feature, input, input.classification, {
        authorizeWrite:
          verifiedBug === null
            ? undefined
            : async () =>
                (await approvalMatchesSource(
                  verifiedBug,
                  input.sourceIssueId,
                  input.linearProjectId
                )) &&
                (await claimApprovalForMemory(verifiedBug, input, "record")),
      });
      if (result.created) {
        return {
          caseId: result.caseId,
          primaryFeatureKey: feature,
          recorded: true as const,
          revision: result.revision,
        };
      }
      let caseId: string | undefined;
      if ("caseId" in result) {
        ({ caseId } = result);
      } else if ("existingCaseId" in result) {
        caseId = result.existingCaseId;
      }
      let reason =
        "This critic approval is already bound to different memory content.";
      if (result.reason === "already_recorded") {
        reason = "This exact conclusion is already recorded. Nothing changed.";
      } else if (result.reason === "active_case_exists") {
        reason =
          "This ticket already has an active case with a different conclusion. Use correct_investigation_case to supersede it.";
      }
      return {
        caseId,
        reason,
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
  inputSchema: casePayloadSchema
    .extend({
      classification: z
        .enum(CLASSIFICATIONS)
        .describe(
          "The final verdict. Use `unproven` only when the evidence genuinely left the claim open."
        ),
      criticApprovalId: triageReviewApprovalIdSchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (
        input.classification === "bug" &&
        input.criticApprovalId === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "A Bug case requires triage-critic APPROVE for the exact current evidence revision.",
          path: ["criticApprovalId"],
        });
      }
    }),
  outputSchema: z.object({
    caseId: z.string().optional(),
    primaryFeatureKey: z.string().optional(),
    reason: z.string().optional(),
    recorded: z.boolean(),
    revision: z.number().optional(),
  }),
});
