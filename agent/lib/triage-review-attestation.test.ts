import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attestTriageReviewVerdict,
  bindTriageReviewSource,
  claimTriageReviewUse,
  findTriageReviewVerdict,
  readAttestedApproval,
  readTriageReviewSource,
  type TriageReviewStorage,
} from "./triage-review-attestation.js";
import {
  TRIAGE_CRITIC_CRITERIA,
  TRIAGE_REVIEW_PACKET_VERSION,
  type TriageCriticVerdict,
  type TriageReviewPacket,
} from "./triage-review-packet.js";

const memoryStorage = (): TriageReviewStorage => {
  const values = new Map<string, string>();
  return {
    read(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    writeOnce(key, value) {
      const existing = values.get(key);
      if (existing !== undefined) {
        return Promise.resolve(existing === value);
      }
      values.set(key, value);
      return Promise.resolve(true);
    },
  };
};

const delayedAtomicStorage = (): TriageReviewStorage => {
  const values = new Map<string, string>();
  return {
    async read(key) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return values.get(key) ?? null;
    },
    async writeOnce(key, value) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const existing = values.get(key);
      if (existing !== undefined) {
        return existing === value;
      }
      values.set(key, value);
      return true;
    },
  };
};

const validApprovalId = `trv_${"a".repeat(
  64
)}_123e4567-e89b-42d3-a456-426614174000`;

const packet = (
  overrides: Partial<TriageReviewPacket> = {}
): TriageReviewPacket => ({
  claim: "A due campaign does not dispatch.",
  criticModel: "openai/gpt-5.6-sol",
  diagnosis: {
    blastRadius: {
      confirmedAffected: "One workspace.",
      limitations: "Bounded query window.",
      method: "Counted failed dispatch records.",
      potentiallyExposed: "Unknown.",
      window: "2026-08-24",
    },
    causalIdentity: {
      causalPathKeys: ["scheduler#dispatch"],
      failingInvariantKey: "campaign.dispatch.once",
      preventionOutcomeKey: "campaign.dispatch.recovered",
      repositoryKey: "acquisity/acquisity",
      triggerConditionKeys: ["campaign.due"],
    },
    codeAnchor: {
      commitSha: "a".repeat(40),
      paths: ["apps/api/send.ts#dispatch"],
      repository: "acquisity/acquisity",
    },
    confidence: "HIGH",
    customerUnblock: "Retry after correction.",
    disprovingObservation: "A provider request would disprove the cause.",
    evidenceLedger: [
      {
        handle: "planetscale-query:dispatch-state",
        lane: "production",
        observedAt: "2026-08-24T11:45:00.000Z",
        status: "VERIFIED",
        summary: "No request exists.",
      },
    ],
    hypotheses: [
      {
        disprovingObservation: "A provider request exists.",
        hypothesis: "The scheduler exits before dispatch.",
        rank: 1,
        status: "CONFIRMED",
        supportingObservation: "No provider request exists.",
      },
    ],
    inference: [],
    mode: "PRODUCTION_FORENSICS",
    regressionSeam: "One due campaign emits one request.",
    rootCause: "The scheduler exits before dispatch.",
    ruledOut: [],
    unknowns: [],
    verifiedFacts: ["No provider request exists."],
  },
  duplicateCandidates: [],
  masterCandidates: [],
  memoryResults: {
    available: true,
    howUsed: "Compared one historical case.",
    matches: [],
    searched: true,
  },
  packetVersion: TRIAGE_REVIEW_PACKET_VERSION,
  proposal: {
    classification: "Bug",
    coreFunctionImpact: "Sending is blocked.",
    hotlaneDecision: "HOTLANE",
    linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    masterEligibilityEvaluatedAt: "2026-08-24T12:00:00.000Z",
    masterRecencyPolicy: "UNBOUNDED",
    priority: "Urgent",
    structuralWrites: ["Create one master."],
  },
  reviewAttempt: 1,
  source: {
    boundedContext: "Campaign did not send.",
    issueId: "ENG-123",
    kind: "Linear",
    workspaceIdentity: "workspace-handle",
  },
  ...overrides,
});

const verdict = (
  evidenceRevision: string,
  result: "PASS" | "FAIL" = "PASS"
): TriageCriticVerdict => ({
  advisory_notes: [],
  blocking_findings:
    result === "FAIL"
      ? [
          {
            claim: "Cause",
            evidence: "Gap",
            impact: "Unsafe",
            next_check: "Query",
          },
        ]
      : [],
  criteria_results: TRIAGE_CRITIC_CRITERIA.map((criterion, index) => ({
    criterion,
    evidence: "Checked.",
    rationale: "Supported.",
    result: index === 0 ? result : "PASS",
  })),
  evidence_revision: evidenceRevision,
  reviewer_model: "openai/gpt-5.6-sol",
  summary: "Review complete.",
  verdict: result === "PASS" ? "APPROVE" : "CHALLENGE",
});

describe("triage review operational attestation", () => {
  it("attests one immutable attempt and scopes the approval to its session", async () => {
    const storage = memoryStorage();
    const revision = "b".repeat(64);
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-1",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(revision),
        },
        storage
      ),
      true
    );
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-2",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(revision),
        },
        storage
      ),
      false
    );
    const found = await findTriageReviewVerdict(
      "session-1",
      packet(),
      revision,
      storage
    );
    assert.equal(found?.verdict, "APPROVE");
    assert.equal(
      await readAttestedApproval(
        "other-session",
        found?.approvalId ?? "",
        storage
      ),
      null
    );
  });

  it("permits exactly one concurrent attestation for an attempt", async () => {
    const storage = delayedAtomicStorage();
    const revision = "9".repeat(64);
    const results = await Promise.all([
      attestTriageReviewVerdict(
        {
          eventId: "event-concurrent-1",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(revision),
        },
        storage
      ),
      attestTriageReviewVerdict(
        {
          eventId: "event-concurrent-2",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(revision),
        },
        storage
      ),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("allows attempt two only for the same reviewer and exact failed criteria", async () => {
    const storage = memoryStorage();
    const firstRevision = "c".repeat(64);
    const secondRevision = "d".repeat(64);
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-1",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(firstRevision, "FAIL"),
        },
        storage
      ),
      true
    );
    const firstApproval = await findTriageReviewVerdict(
      "session-1",
      packet(),
      firstRevision,
      storage
    );
    assert.ok(firstApproval);
    const secondPacket = packet({
      previousEvidenceRevision: firstRevision,
      reviewAttempt: 2,
      targetedRecheckCriteria: ["claim_fidelity"],
    });
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-wrong-model",
          packet: secondPacket,
          sessionId: "session-1",
          verdict: {
            ...verdict(secondRevision),
            reviewer_model: "openai/gpt-5.6-terra",
          },
        },
        storage
      ),
      false
    );
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-wrong-criteria",
          packet: {
            ...secondPacket,
            targetedRecheckCriteria: ["reachability"],
          },
          sessionId: "session-1",
          verdict: verdict(secondRevision),
        },
        storage
      ),
      false
    );
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-2",
          packet: secondPacket,
          sessionId: "session-1",
          verdict: verdict(secondRevision),
        },
        storage
      ),
      true
    );
    assert.equal(
      await findTriageReviewVerdict(
        "session-1",
        packet(),
        firstRevision,
        storage
      ),
      null
    );
    assert.equal(
      await readAttestedApproval(
        "session-1",
        firstApproval.approvalId,
        storage
      ),
      null
    );
    assert.equal(
      (
        await findTriageReviewVerdict(
          "session-1",
          secondPacket,
          secondRevision,
          storage
        )
      )?.verdict,
      "APPROVE"
    );
  });

  it("rejects attempt two from a different source and permits its own first review", async () => {
    const storage = memoryStorage();
    const firstRevision = "1".repeat(64);
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-1",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(firstRevision, "FAIL"),
        },
        storage
      ),
      true
    );
    const otherSource = packet({
      previousEvidenceRevision: firstRevision,
      reviewAttempt: 2,
      source: {
        boundedContext: "Another campaign did not send.",
        issueId: "ENG-999",
        kind: "Linear",
        workspaceIdentity: "other-workspace",
      },
      targetedRecheckCriteria: ["claim_fidelity"],
    });
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-2",
          packet: otherSource,
          sessionId: "session-1",
          verdict: verdict("2".repeat(64)),
        },
        storage
      ),
      false
    );
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-3",
          packet: packet({
            source: otherSource.source,
          }),
          sessionId: "session-1",
          verdict: verdict("3".repeat(64)),
        },
        storage
      ),
      true
    );
  });

  it("uses the one remaining attempt for a full review after approval is invalidated", async () => {
    const storage = memoryStorage();
    const firstRevision = "4".repeat(64);
    const secondRevision = "5".repeat(64);
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-1",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(firstRevision),
        },
        storage
      ),
      true
    );
    const firstApproval = await findTriageReviewVerdict(
      "session-1",
      packet(),
      firstRevision,
      storage
    );
    assert.ok(firstApproval);
    const revised = packet({
      previousEvidenceRevision: firstRevision,
      reviewAttempt: 2,
      targetedRecheckCriteria: [...TRIAGE_CRITIC_CRITERIA],
    });
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-partial-recheck",
          packet: {
            ...revised,
            targetedRecheckCriteria: ["master_match"],
          },
          sessionId: "session-1",
          verdict: verdict(secondRevision),
        },
        storage
      ),
      false
    );
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-full-recheck",
          packet: revised,
          sessionId: "session-1",
          verdict: verdict(secondRevision),
        },
        storage
      ),
      true
    );
    assert.equal(
      await findTriageReviewVerdict(
        "session-1",
        packet(),
        firstRevision,
        storage
      ),
      null
    );
    assert.equal(
      await readAttestedApproval(
        "session-1",
        firstApproval.approvalId,
        storage
      ),
      null
    );
    assert.equal(
      (
        await findTriageReviewVerdict(
          "session-1",
          revised,
          secondRevision,
          storage
        )
      )?.verdict,
      "APPROVE"
    );
  });

  it("revokes an earlier approval when attempt two challenges the revision", async () => {
    const storage = memoryStorage();
    const firstRevision = "6".repeat(64);
    const secondRevision = "7".repeat(64);
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-first-approval",
          packet: packet(),
          sessionId: "session-1",
          verdict: verdict(firstRevision),
        },
        storage
      ),
      true
    );
    const firstApproval = await findTriageReviewVerdict(
      "session-1",
      packet(),
      firstRevision,
      storage
    );
    assert.ok(firstApproval);
    const revised = packet({
      previousEvidenceRevision: firstRevision,
      reviewAttempt: 2,
      targetedRecheckCriteria: [...TRIAGE_CRITIC_CRITERIA],
    });
    assert.equal(
      await attestTriageReviewVerdict(
        {
          eventId: "event-second-challenge",
          packet: revised,
          sessionId: "session-1",
          verdict: verdict(secondRevision, "FAIL"),
        },
        storage
      ),
      true
    );
    assert.equal(
      await readAttestedApproval(
        "session-1",
        firstApproval.approvalId,
        storage
      ),
      null
    );
    assert.equal(
      (
        await findTriageReviewVerdict(
          "session-1",
          revised,
          secondRevision,
          storage
        )
      )?.verdict,
      "CHALLENGE"
    );
  });

  it("binds source and downstream purposes once while permitting exact retries", async () => {
    const storage = memoryStorage();
    const source = {
      linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
      sourceIssueId: "ENG-123",
    };
    assert.equal(
      await bindTriageReviewSource(validApprovalId, source, storage),
      true
    );
    assert.equal(
      await bindTriageReviewSource(validApprovalId, source, storage),
      true
    );
    assert.equal(
      await bindTriageReviewSource(
        validApprovalId,
        { ...source, sourceIssueId: "ENG-124" },
        storage
      ),
      false
    );
    const use = {
      payloadDigest: "e".repeat(64),
      purpose: "memory" as const,
      sourceIssueId: "ENG-123",
    };
    assert.equal(
      await claimTriageReviewUse(validApprovalId, use, storage),
      true
    );
    assert.equal(
      await claimTriageReviewUse(validApprovalId, use, storage),
      true
    );
    assert.equal(
      await claimTriageReviewUse(
        validApprovalId,
        { ...use, payloadDigest: "f".repeat(64) },
        storage
      ),
      false
    );
  });

  it("rejects malformed approval ids before reading or writing storage", async () => {
    const storage: TriageReviewStorage = {
      read() {
        throw new Error("storage read must not run");
      },
      writeOnce() {
        throw new Error("storage write must not run");
      },
    };
    const malformed = "trv_../../user-preferences/x_y";
    const source = {
      linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
      sourceIssueId: "ENG-123",
    };
    const use = {
      payloadDigest: "e".repeat(64),
      purpose: "memory" as const,
      sourceIssueId: "ENG-123",
    };

    assert.equal(
      await readAttestedApproval("session-1", malformed, storage),
      null
    );
    assert.equal(await readTriageReviewSource(malformed, storage), null);
    assert.equal(
      await bindTriageReviewSource(malformed, source, storage),
      false
    );
    assert.equal(await claimTriageReviewUse(malformed, use, storage), false);
  });
});
