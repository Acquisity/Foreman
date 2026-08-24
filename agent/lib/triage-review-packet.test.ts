import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import correctInvestigationCase from "../tools/correct_investigation_case.js";
import recordInvestigationCase from "../tools/record_investigation_case.js";
import {
  hashTriageReviewPacket,
  serializeTriageReviewPacket,
  stampTriageReviewPolicy,
  TRIAGE_CRITIC_CRITERIA,
  TRIAGE_REVIEW_PACKET_VERSION,
  type TriageReviewPacketInput,
  triageCriticVerdictSchema,
  triageReviewPacketInputSchema,
} from "./triage-review-packet.js";

const input = (): TriageReviewPacketInput => ({
  claim: "A scheduled campaign did not send at the expected time.",
  diagnosis: {
    blastRadius: {
      confirmedAffected: "1 workspace",
      limitations: "No per-user failure counter exists.",
      method: "Count distinct workspaces with the failed terminal state.",
      potentiallyExposed: "3 workspaces",
      window: "2026-08-24T00:00:00Z through 2026-08-24T12:00:00Z",
    },
    causalIdentity: {
      causalPathKeys: [
        "acquisity/acquisity:apps/api/src/send.ts#dispatchcampaign",
      ],
      failingInvariantKey: "campaign.dispatch.exactly-once",
      preventionOutcomeKey: "provider.request.exactly-one",
      repositoryKey: "acquisity/acquisity",
      triggerConditionKeys: ["campaign.due", "sending-window.open"],
    },
    codeAnchor: {
      commitSha: "a".repeat(40),
      paths: ["apps/api/src/send.ts:dispatchCampaign"],
      repository: "Acquisity/Acquisity",
    },
    confidence: "HIGH",
    customerUnblock: "Support can safely requeue the failed campaign.",
    disprovingObservation:
      "A failed campaign whose dispatch event reached the provider would disprove this cause.",
    evidenceLedger: [
      {
        lane: "production",
        status: "VERIFIED",
        summary: "The dispatch row stopped before provider submission.",
      },
    ],
    inference: ["The scheduler skipped the dispatch transition."],
    mode: "PRODUCTION_FORENSICS",
    regressionSeam: "Dispatching a due campaign emits one provider request.",
    rootCause: "The scheduler marked the campaign complete before dispatch.",
    ruledOut: ["The workspace sending window was open."],
    unknowns: [],
    verifiedFacts: ["No provider request exists for the failed dispatch."],
  },
  masterCandidates: [],
  memoryResults: {
    available: true,
    howUsed: "One analogy was checked and contradicted by current evidence.",
    matches: [
      {
        relevance: "Similar symptom, different cause.",
        sourceIssueId: "ENG-1",
      },
    ],
    searched: true,
  },
  proposal: {
    classification: "Bug",
    coreFunctionImpact: "The core sending workflow is blocked.",
    hotlaneDecision: "HOTLANE",
    linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    masterEligibilityEvaluatedAt: "2026-08-24T12:00:00.000Z",
    masterRecencyPolicy: "UNBOUNDED",
    priority: "Urgent",
    structuralWrites: ["Create one causal master and parent the report."],
  },
  reviewAttempt: 1,
  source: {
    boundedContext: "The customer expected the due campaign to send.",
    issueId: "ENG-123",
    kind: "Linear",
    workspaceIdentity: "Pinned workspace from the source investigation.",
  },
});

const casePayload = {
  claim: "A scheduled campaign did not send.",
  classification: "bug" as const,
  confidence: "high" as const,
  linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
  rootCause: "The scheduler skipped the dispatch transition.",
  sourceIssueId: "ENG-123",
  sourceIssueUrl: "https://linear.app/acquisity/issue/ENG-123/example",
};

const criticApprovalId = `trv_${"a".repeat(64)}_0ae59086-e924-42d1-b7ff-f9c750a2a7c9`;

describe("triage review packets", () => {
  it("hashes canonical content independently of object key order", () => {
    const packet = {
      ...input(),
      criticModel: "openai/gpt-5.6-sol",
      packetVersion: TRIAGE_REVIEW_PACKET_VERSION,
    };
    const reordered = Object.fromEntries(Object.entries(packet).reverse());

    assert.equal(
      hashTriageReviewPacket(serializeTriageReviewPacket(packet)),
      hashTriageReviewPacket(
        serializeTriageReviewPacket(reordered as typeof packet)
      )
    );
  });

  it("permits exactly one targeted recheck after a first review", () => {
    assert.equal(
      triageReviewPacketInputSchema.safeParse(input()).success,
      true
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        reviewAttempt: 2,
      }).success,
      false
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        previousEvidenceRevision: "b".repeat(64),
        reviewAttempt: 2,
        targetedRecheckCriteria: ["causality"],
      }).success,
      true
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        reviewAttempt: 3,
      }).success,
      false
    );
  });

  it("requires all twelve named criteria for a structured critic verdict", () => {
    const verdict = {
      advisory_notes: [],
      blocking_findings: [],
      criteria_results: TRIAGE_CRITIC_CRITERIA.map((criterion) => ({
        criterion,
        evidence: "Current packet evidence.",
        rationale: "The criterion is supported.",
        result: "PASS" as const,
      })),
      evidence_revision: "c".repeat(64),
      reviewer_model: "openai/gpt-5.6-sol",
      summary: "The proposed Bug is supported.",
      verdict: "APPROVE" as const,
    };
    assert.equal(triageCriticVerdictSchema.safeParse(verdict).success, true);
    assert.equal(
      triageCriticVerdictSchema.safeParse({
        ...verdict,
        criteria_results: verdict.criteria_results.slice(1),
      }).success,
      false
    );
    assert.equal(
      triageCriticVerdictSchema.safeParse({
        ...verdict,
        criteria_results: verdict.criteria_results.map((result, index) =>
          index === 0 ? { ...result, result: "FAIL" as const } : result
        ),
      }).success,
      false
    );
    assert.equal(
      triageCriticVerdictSchema.safeParse({
        ...verdict,
        verdict: "CHALLENGE",
      }).success,
      false
    );
  });

  it("requires selected masters to be unique reviewed causal candidates", () => {
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        masterCandidates: [
          {
            causalMatch: true,
            createdAt: "2026-07-01T00:00:00.000Z",
            issueId: "ENG-99",
            rationale: "Same invariant and causal path.",
          },
        ],
        proposal: {
          ...input().proposal,
          masterRecencyPolicy: "THIRTY_DAY",
          staleMasterCandidateIssueId: "ENG-99",
        },
      }).success,
      true
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        proposal: {
          ...input().proposal,
          staleMasterCandidateIssueId: "ENG-99",
        },
      }).success,
      false
    );
  });

  it("enforces pinned 30-day and unbounded master policies", () => {
    const candidate = {
      causalMatch: true,
      createdAt: "2026-07-25T12:00:00.000Z",
      issueId: "ENG-99",
      rationale: "Same invariant and causal path.",
    };
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        masterCandidates: [candidate],
        proposal: {
          ...input().proposal,
          masterCandidateIssueId: candidate.issueId,
          masterRecencyPolicy: "THIRTY_DAY",
        },
      }).success,
      true
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        masterCandidates: [candidate],
        proposal: {
          ...input().proposal,
          masterRecencyPolicy: "THIRTY_DAY",
          staleMasterCandidateIssueId: candidate.issueId,
        },
      }).success,
      false
    );
    assert.equal(
      triageReviewPacketInputSchema.safeParse({
        ...input(),
        masterCandidates: [
          { ...candidate, createdAt: "2026-07-01T00:00:00.000Z" },
        ],
        proposal: {
          ...input().proposal,
          staleMasterCandidateIssueId: candidate.issueId,
        },
      }).success,
      false
    );
  });

  it("server-stamps policy and evaluation time from the authenticated route", () => {
    const stamped = stampTriageReviewPolicy(
      {
        ...input(),
        proposal: {
          ...input().proposal,
          masterEligibilityEvaluatedAt: "2099-01-01T00:00:00.000Z",
          masterRecencyPolicy: "THIRTY_DAY",
        },
      },
      { evaluatedAt: "2026-08-24T12:00:00.000Z", intakeOnly: false }
    );
    assert.equal(stamped.proposal.masterRecencyPolicy, "UNBOUNDED");
    assert.equal(
      stamped.proposal.masterEligibilityEvaluatedAt,
      "2026-08-24T12:00:00.000Z"
    );
    assert.equal(
      stampTriageReviewPolicy(input(), {
        evaluatedAt: "2026-08-24T12:00:00.000Z",
        intakeOnly: true,
      }).proposal.masterRecencyPolicy,
      "THIRTY_DAY"
    );
  });
});

describe("investigation memory critic gate", () => {
  it("requires an opaque attested approval id for a Bug record", () => {
    assert.ok(recordInvestigationCase.inputSchema instanceof z.ZodType);
    assert.equal(
      recordInvestigationCase.inputSchema.safeParse(casePayload).success,
      false
    );
    assert.equal(
      recordInvestigationCase.inputSchema.safeParse({
        ...casePayload,
        criticApprovalId,
      }).success,
      true
    );
  });

  it("requires an opaque attested approval id for a corrected Bug", () => {
    assert.ok(correctInvestigationCase.inputSchema instanceof z.ZodType);
    const correction = {
      ...casePayload,
      correctionReason: "New runtime evidence proved the scheduler defect.",
      supersedesCaseId: "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    };
    assert.equal(
      correctInvestigationCase.inputSchema.safeParse(correction).success,
      false
    );
    assert.equal(
      correctInvestigationCase.inputSchema.safeParse({
        ...correction,
        criticApprovalId,
      }).success,
      true
    );
  });
});
