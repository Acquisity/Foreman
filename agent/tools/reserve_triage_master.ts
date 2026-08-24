import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import {
  causalFingerprint,
  reserveMaster,
} from "#lib/investigation-memory/master-reservation.js";
import {
  approvalMatchesSource,
  claimApprovalForMaster,
  verifyTriageApproval,
} from "#lib/triage-review-approval.js";
import { triageReviewApprovalIdSchema } from "#lib/triage-review-attestation.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const PUBLIC_RESERVATION_ERRORS = new Set([
  "Only 30-day intake may advance a stale master generation.",
  "The reviewed predecessor is not more than 30 days old.",
]);

export const publicReservationErrorMessage = (error: unknown): string =>
  error instanceof Error && PUBLIC_RESERVATION_ERRORS.has(error.message)
    ? error.message
    : "The causal reservation is unavailable.";

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Acquire the server-side causal reservation immediately before creating a new root-cause Linear master. Call only after the final Linear re-search, using the opaque approval ID returned by read_triage_review_verdict. The fingerprint is derived from the approved packet's stable invariant, causal-path, trigger, and prevention keys, never symptom prose or the source ticket. The packet's reviewed stale master supplies a new generation for 30-day intake; otherwise the initial generation remains permanent. Only the transaction that atomically reserves that causal generation receives acquired: true. Conflicts and retries fail closed, and unresolved reservations never expire into permission for another create.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        acquired: false as const,
        reason: "This session is not authorized to reserve a triage master.",
      };
    }
    try {
      const verified = await verifyTriageApproval(
        await ctx.getSandbox(),
        ctx.session.id,
        input.criticApprovalId
      );
      if (
        verified === null ||
        verified.packet.proposal.classification !== "Bug"
      ) {
        return {
          acquired: false as const,
          reason:
            "The opaque critic approval is absent, not APPROVE, or no longer matches its packet, model, and repository revision.",
        };
      }
      const { linearProjectId } = verified.packet.proposal;
      if (linearProjectId === null) {
        return {
          acquired: false as const,
          reason:
            "A pre-ticket Intercom packet cannot reserve a master until Foreman assigns a Linear project and obtains approval for a new packet revision.",
        };
      }
      if (
        !(await approvalMatchesSource(
          verified,
          input.sourceIssueId,
          linearProjectId
        ))
      ) {
        return {
          acquired: false as const,
          reason: "The approval is bound to a different source issue.",
        };
      }
      if (verified.packet.proposal.masterCandidateIssueId !== undefined) {
        return {
          acquired: false as const,
          existingMasterIssueId:
            verified.packet.proposal.masterCandidateIssueId,
          reason:
            "The approved packet selected an existing current master; reuse it instead of reserving a new one.",
        };
      }
      const generationKey =
        verified.packet.proposal.staleMasterCandidateIssueId ?? "initial";
      const predecessorCreatedAt =
        generationKey === "initial"
          ? undefined
          : verified.packet.masterCandidates.find(
              ({ issueId }) => issueId === generationKey
            )?.createdAt;
      const fingerprint = causalFingerprint(
        verified.packet.diagnosis.causalIdentity
      );
      if (
        !(await claimApprovalForMaster(
          verified,
          input.sourceIssueId,
          fingerprint,
          generationKey
        ))
      ) {
        return {
          acquired: false as const,
          reason:
            "This critic approval is already bound to a different master reservation.",
        };
      }
      return await reserveMaster({
        approvalId: verified.approval.approvalId,
        causalIdentity: verified.packet.diagnosis.causalIdentity,
        eligibilityEvaluatedAt:
          verified.packet.proposal.masterEligibilityEvaluatedAt,
        evidenceRevision: verified.approval.evidenceRevision,
        generationKey,
        masterRecencyPolicy: verified.packet.proposal.masterRecencyPolicy,
        predecessorCreatedAt,
        reviewAttempt: verified.approval.attempt,
        reviewerModel: verified.approval.reviewerModel,
        sourceIssueId: input.sourceIssueId,
      });
    } catch (error) {
      return {
        acquired: false as const,
        reason: publicReservationErrorMessage(error),
      };
    }
  },
  inputSchema: z.object({
    criticApprovalId: triageReviewApprovalIdSchema,
    sourceIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
  }),
  outputSchema: z.object({
    acquired: z.boolean(),
    causalFingerprint: z.string().optional(),
    existingMasterCreatedAt: z.iso.datetime().optional(),
    existingMasterIssueId: z.string().optional(),
    reason: z.string().optional(),
    reservationId: z.string().optional(),
  }),
});
