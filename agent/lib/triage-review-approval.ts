import type { RuntimeSandboxSession } from "eve/sandbox";
import type { CasePayload } from "./investigation-memory/case.js";
import {
  bindTriageReviewSource,
  claimTriageReviewUse,
  readAttestedApproval,
  readTriageReviewSource,
  type TriageReviewAttestation,
  triageReviewPayloadDigest,
} from "./triage-review-attestation.js";
import type { TriageReviewPacket } from "./triage-review-packet.js";
import { readVerifiedTriageReviewPacket } from "./triage-review-packet-file.js";

export interface VerifiedTriageApproval {
  readonly approval: TriageReviewAttestation;
  readonly packet: TriageReviewPacket;
}

export const verifyTriageApproval = async (
  sandbox: RuntimeSandboxSession,
  sessionId: string,
  approvalId: string
): Promise<VerifiedTriageApproval | null> => {
  const approval = await readAttestedApproval(sessionId, approvalId);
  if (approval === null) {
    return null;
  }
  const packet = await readVerifiedTriageReviewPacket(
    sandbox,
    approval.evidenceRevision
  );
  if (
    !packet.verified ||
    packet.packet.reviewAttempt !== approval.attempt ||
    packet.packet.criticModel !== approval.reviewerModel ||
    packet.packet.proposal.linearProjectId !== approval.linearProjectId
  ) {
    return null;
  }
  return { approval, packet: packet.packet };
};

const normalize = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ");

const normalizedSetMatches = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  const normalizedLeft = [...new Set(left.map(normalize))].sort();
  const normalizedRight = [...new Set(right.map(normalize))].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
};

export const approvalMatchesSource = async (
  verified: VerifiedTriageApproval,
  sourceIssueId: string,
  linearProjectId: string
): Promise<boolean> => {
  if (verified.approval.linearProjectId !== linearProjectId) {
    return false;
  }
  if (verified.approval.sourceIssueId !== null) {
    return verified.approval.sourceIssueId === sourceIssueId;
  }
  const binding = { linearProjectId, sourceIssueId };
  if (!(await bindTriageReviewSource(verified.approval.approvalId, binding))) {
    return false;
  }
  const stored = await readTriageReviewSource(verified.approval.approvalId);
  return (
    stored?.linearProjectId === linearProjectId &&
    stored.sourceIssueId === sourceIssueId
  );
};

export const approvalMatchesBugCaseContent = (
  verified: VerifiedTriageApproval,
  payload: CasePayload
): boolean => {
  const { blastRadius } = verified.packet.diagnosis;
  return (
    verified.packet.proposal.classification === "Bug" &&
    normalize(verified.packet.claim) === normalize(payload.claim) &&
    normalize(verified.packet.diagnosis.rootCause) ===
      normalize(payload.rootCause) &&
    verified.packet.diagnosis.confidence.toLowerCase() === payload.confidence &&
    verified.packet.diagnosis.codeAnchor.commitSha === payload.commitSha &&
    normalizedSetMatches(
      verified.packet.diagnosis.codeAnchor.paths,
      payload.codePaths
    ) &&
    blastRadius.affectedOrgCount === payload.affectedOrgCount &&
    blastRadius.affectedUserCount === payload.affectedUserCount &&
    blastRadius.countedAt === payload.countedAt
  );
};

export const claimApprovalForMemory = (
  verified: VerifiedTriageApproval,
  payload: CasePayload,
  operation: "record" | "correct",
  correctionIdentity?: { correctionReason: string; supersedesCaseId: string }
): Promise<boolean> =>
  claimTriageReviewUse(verified.approval.approvalId, {
    payloadDigest: triageReviewPayloadDigest({
      correctionIdentity,
      operation,
      payload,
    }),
    purpose: "memory",
    sourceIssueId: payload.sourceIssueId,
  });

export const claimApprovalForMaster = (
  verified: VerifiedTriageApproval,
  sourceIssueId: string,
  causalFingerprint: string,
  generationKey: string
): Promise<boolean> =>
  claimTriageReviewUse(verified.approval.approvalId, {
    payloadDigest: triageReviewPayloadDigest({
      causalFingerprint,
      generationKey,
      masterEligibilityEvaluatedAt:
        verified.packet.proposal.masterEligibilityEvaluatedAt,
      masterRecencyPolicy: verified.packet.proposal.masterRecencyPolicy,
      sourceIssueId,
    }),
    purpose: "master",
    sourceIssueId,
  });
