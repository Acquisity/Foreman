import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readDocument, TRIAGE_REVIEW_PREFIX, writeDocument } from "./blob.js";
import {
  canonicalizeTriageReviewValue,
  evidenceRevisionSchema,
  TRIAGE_CRITIC_CRITERIA,
  type TriageCriticVerdict,
  type TriageReviewPacket,
} from "./triage-review-packet.js";

const verdictNameSchema = z.enum([
  "APPROVE",
  "CHALLENGE",
  "INSUFFICIENT_EVIDENCE",
]);

export const triageReviewApprovalIdSchema = z
  .string()
  .regex(
    /^trv_[a-f0-9]{64}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
  );

const attestationSchema = z.object({
  approvalId: triageReviewApprovalIdSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  eventIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceRevision: evidenceRevisionSchema,
  failedCriteria: z.array(z.enum(TRIAGE_CRITIC_CRITERIA)).max(12),
  intercomConversationIdHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  linearProjectId: z.uuid().nullable(),
  previousEvidenceRevision: evidenceRevisionSchema.nullable(),
  reviewerModel: z.string().min(1).max(128),
  sessionKey: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceIssueId: z
    .string()
    .regex(/^[A-Z]{2,10}-\d{1,9}$/u)
    .nullable(),
  verdict: verdictNameSchema,
});

export type TriageReviewAttestation = z.infer<typeof attestationSchema>;

const sourceBindingSchema = z.object({
  linearProjectId: z.uuid().nullable(),
  sourceIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
});
export type TriageReviewSourceBinding = z.infer<typeof sourceBindingSchema>;

const useBindingSchema = z.object({
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  purpose: z.enum(["master", "memory"]),
  sourceIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
});

export interface TriageReviewStorage {
  read: (key: string) => Promise<string | null>;
  writeOnce: (key: string, value: string) => Promise<boolean>;
}

const blobStorage: TriageReviewStorage = {
  async read(key) {
    const result = await readDocument(key);
    return result.found ? result.content : null;
  },
  async writeOnce(key, value) {
    const existing = await readDocument(key);
    if (existing.found) {
      return existing.content === value;
    }
    try {
      await writeDocument(key, value, {
        allowOverwrite: false,
        contentType: "application/json",
      });
      return true;
    } catch (error) {
      const raced = await readDocument(key);
      if (raced.found) {
        return raced.content === value;
      }
      throw new Error("The triage review attestation could not be persisted.", {
        cause: error,
      });
    }
  },
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const triageReviewSessionKey = (sessionId: string): string =>
  digest(sessionId);

const canonicalSourceIdentity = (packet: TriageReviewPacket): string =>
  packet.source.kind === "Linear"
    ? `linear:${packet.source.issueId.toLowerCase()}`
    : `intercom:${digest(packet.source.conversationId)}`;

export const triageReviewChainKey = (
  sessionId: string,
  packet: TriageReviewPacket
): string => digest(`${sessionId}\n${canonicalSourceIdentity(packet)}`);

const attemptKey = (chainKey: string, attempt: 1 | 2): string =>
  `${TRIAGE_REVIEW_PREFIX}chains/${chainKey}/attempt-${attempt}.json`;

const sourceKey = (approvalId: string): string =>
  `${TRIAGE_REVIEW_PREFIX}approvals/${approvalId}/source.json`;

const useKey = (approvalId: string, purpose: "master" | "memory"): string =>
  `${TRIAGE_REVIEW_PREFIX}approvals/${approvalId}/uses/${purpose}.json`;

const parseAttestation = (
  value: string | null
): TriageReviewAttestation | null =>
  value === null ? null : attestationSchema.parse(JSON.parse(value));

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((entry) => new Set(right).has(entry));

export const attestTriageReviewVerdict = async (
  input: {
    eventId: string;
    packet: TriageReviewPacket;
    sessionId: string;
    verdict: TriageCriticVerdict;
  },
  storage: TriageReviewStorage = blobStorage
): Promise<boolean> => {
  const { packet, verdict } = input;
  const sessionKey = triageReviewSessionKey(input.sessionId);
  const chainKey = triageReviewChainKey(input.sessionId, packet);
  const currentKey = attemptKey(chainKey, packet.reviewAttempt);
  if ((await storage.read(currentKey)) !== null) {
    return false;
  }

  if (packet.reviewAttempt === 1) {
    if ((await storage.read(attemptKey(chainKey, 2))) !== null) {
      return false;
    }
  } else {
    const previous = parseAttestation(
      await storage.read(attemptKey(chainKey, 1))
    );
    const targets = packet.targetedRecheckCriteria ?? [];
    const expectedTargets =
      previous?.verdict === "APPROVE"
        ? TRIAGE_CRITIC_CRITERIA
        : (previous?.failedCriteria ?? []);
    if (
      previous === null ||
      previous.evidenceRevision !== packet.previousEvidenceRevision ||
      previous.reviewerModel !== verdict.reviewer_model ||
      !sameSet(expectedTargets, targets)
    ) {
      return false;
    }
  }

  const attestation: TriageReviewAttestation = {
    approvalId: `trv_${chainKey}_${randomUUID()}`,
    attempt: packet.reviewAttempt,
    eventIdHash: digest(input.eventId),
    evidenceRevision: verdict.evidence_revision,
    failedCriteria: verdict.criteria_results
      .filter(({ result }) => result === "FAIL")
      .map(({ criterion }) => criterion),
    intercomConversationIdHash:
      packet.source.kind === "Intercom"
        ? digest(packet.source.conversationId)
        : null,
    linearProjectId: packet.proposal.linearProjectId,
    previousEvidenceRevision: packet.previousEvidenceRevision ?? null,
    reviewerModel: verdict.reviewer_model,
    sessionKey,
    sourceIssueId:
      packet.source.kind === "Linear" ? packet.source.issueId : null,
    verdict: verdict.verdict,
  };
  const serialized = JSON.stringify(attestation);
  if (!(await storage.writeOnce(currentKey, serialized))) {
    return false;
  }
  return true;
};

export const findTriageReviewVerdict = async (
  sessionId: string,
  packet: TriageReviewPacket,
  evidenceRevision: string,
  storage: TriageReviewStorage = blobStorage
): Promise<TriageReviewAttestation | null> => {
  const chainKey = triageReviewChainKey(sessionId, packet);
  const results = await Promise.all(
    ([2, 1] as const).map(async (attempt) =>
      parseAttestation(await storage.read(attemptKey(chainKey, attempt)))
    )
  );
  for (const result of results) {
    if (result?.evidenceRevision === evidenceRevision) {
      return result;
    }
  }
  return null;
};

export const readAttestedApproval = async (
  sessionId: string,
  approvalId: string,
  storage: TriageReviewStorage = blobStorage
): Promise<TriageReviewAttestation | null> => {
  const parsedApprovalId = triageReviewApprovalIdSchema.safeParse(approvalId);
  if (!parsedApprovalId.success) {
    return null;
  }
  const sessionKey = triageReviewSessionKey(sessionId);
  const [, chainKey] = parsedApprovalId.data.split("_");
  if (chainKey === undefined) {
    return null;
  }
  const results = await Promise.all(
    ([2, 1] as const).map(async (attempt) =>
      parseAttestation(await storage.read(attemptKey(chainKey, attempt)))
    )
  );
  for (const result of results) {
    if (
      result?.approvalId === approvalId &&
      result.sessionKey === sessionKey &&
      result.verdict === "APPROVE"
    ) {
      return result;
    }
  }
  return null;
};

export const bindTriageReviewSource = async (
  approvalId: string,
  binding: TriageReviewSourceBinding,
  storage: TriageReviewStorage = blobStorage
): Promise<boolean> => {
  const parsedApprovalId = triageReviewApprovalIdSchema.safeParse(approvalId);
  if (!parsedApprovalId.success) {
    return false;
  }
  return await storage.writeOnce(
    sourceKey(parsedApprovalId.data),
    JSON.stringify(sourceBindingSchema.parse(binding))
  );
};

export const readTriageReviewSource = async (
  approvalId: string,
  storage: TriageReviewStorage = blobStorage
): Promise<TriageReviewSourceBinding | null> => {
  const parsedApprovalId = triageReviewApprovalIdSchema.safeParse(approvalId);
  if (!parsedApprovalId.success) {
    return null;
  }
  const value = await storage.read(sourceKey(parsedApprovalId.data));
  return value === null ? null : sourceBindingSchema.parse(JSON.parse(value));
};

export const claimTriageReviewUse = async (
  approvalId: string,
  input: z.input<typeof useBindingSchema>,
  storage: TriageReviewStorage = blobStorage
): Promise<boolean> => {
  const parsedApprovalId = triageReviewApprovalIdSchema.safeParse(approvalId);
  if (!parsedApprovalId.success) {
    return false;
  }
  return await storage.writeOnce(
    useKey(parsedApprovalId.data, input.purpose),
    JSON.stringify(useBindingSchema.parse(input))
  );
};

export const triageReviewPayloadDigest = (value: unknown): string =>
  digest(JSON.stringify(canonicalizeTriageReviewValue(value)));
