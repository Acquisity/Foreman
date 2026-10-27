import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITIC_CRITERIA } from "../subagents/critic/agent.js";
import { formatOpsEvent } from "./ops-log.js";
import { CRITIC_FINDING } from "./triage-fixtures.js";
import {
  criticBlocked,
  criticTaskPacket,
  criticVerdictFields,
  settleCriticRound,
} from "./triage-log.js";
import { triageResultSchema } from "./triage-replay/schema.js";

const COMMIT = "c".repeat(40);
const PACKET = {
  commit: COMMIT,
  documentId: "doc-1",
  issue: "ENG-1",
  updatedAt: "2026-10-27T10:00:00.000Z",
};
const reviewed = (over: Record<string, string> = {}) => ({
  commit: COMMIT,
  document_id: "doc-1",
  document_updated_at: "2026-10-27T10:00:00.000Z",
  issue_id: "ENG-1",
  ...over,
});
const criteria = (fail = 0, count: number = CRITIC_CRITERIA.length) =>
  CRITIC_CRITERIA.slice(0, count).map((criterion, i) => ({
    criterion,
    evidence: "read",
    rationale: "checked",
    result: i < fail ? "FAIL" : "PASS",
  }));
const reply = (over: Record<string, unknown> = {}) => ({
  advisory_notes: [],
  blocking_findings: [],
  criteria_results: criteria(),
  reviewed: reviewed(),
  summary: "s",
  verdict: "APPROVE",
  ...over,
});
const skillLoadFailure = reply({
  criteria_results: [],
  reviewed: reviewed({ commit: "unpinned" }),
  verdict: "INSUFFICIENT_EVIDENCE",
});
const settle = (verdicts: unknown[]) =>
  verdicts.reduce<ReturnType<typeof settleCriticRound>>(
    (rounds, output) =>
      settleCriticRound(
        rounds,
        "ENG-1",
        criticVerdictFields("completed", output, PACKET).counted
      ),
    {}
  );

describe("the critic policy", () => {
  it("counts a valid approval as an approval and a challenge as an objection", () => {
    assert.equal(
      criticVerdictFields("completed", reply(), PACKET).counted,
      "approve"
    );
    assert.equal(
      criticVerdictFields(
        "completed",
        reply({
          blocking_findings: [CRITIC_FINDING],
          criteria_results: criteria(1),
          verdict: "CHALLENGE",
        }),
        PACKET
      ).counted,
      "objection"
    );
  });

  it("does not count a review that could not start or ran unpinned as an objection", () => {
    assert.equal(
      criticVerdictFields("completed", skillLoadFailure, PACKET).counted,
      "failed"
    );
    const unpinned = reply({
      blocking_findings: [CRITIC_FINDING],
      reviewed: reviewed({ commit: "unpinned" }),
      verdict: "CHALLENGE",
    });
    assert.equal(
      criticVerdictFields("completed", unpinned, PACKET).counted,
      "failed"
    );
    const rounds = settle([skillLoadFailure, skillLoadFailure]);
    assert.equal(rounds["ENG-1"].objections, 0);
    assert.equal(criticBlocked(rounds, "ENG-1"), false);
  });

  it("does not count a review of another ticket, or one with no echo", () => {
    assert.equal(
      criticVerdictFields(
        "completed",
        reply({ reviewed: reviewed({ issue_id: "ENG-2" }) }),
        PACKET
      ).counted,
      "failed"
    );
    const { reviewed: _dropped, ...noEcho } = reply();
    assert.equal(
      criticVerdictFields("completed", noEcho, PACKET).counted,
      "failed"
    );
  });

  it("reads an echo that differs only in case, spacing or code marks as the same ticket and commit", () => {
    const challenge = (echo: Record<string, string>) =>
      reply({
        blocking_findings: [CRITIC_FINDING],
        criteria_results: criteria(1),
        reviewed: reviewed(echo),
        verdict: "CHALLENGE",
      });
    for (const echo of <Record<string, string>[]>[
      { issue_id: "eng-1" },
      { issue_id: " ENG-1 " },
      { issue_id: "`ENG-1`" },
      { commit: COMMIT.toUpperCase() },
      { commit: ` ${COMMIT} ` },
    ]) {
      assert.equal(
        criticVerdictFields("completed", challenge(echo), PACKET).counted,
        "objection",
        JSON.stringify(echo)
      );
    }
  });

  it("counts a review of another commit, document or version as failed, not as an objection", () => {
    const challenge = (echo: Record<string, string>) =>
      reply({
        blocking_findings: [CRITIC_FINDING],
        criteria_results: criteria(1),
        reviewed: reviewed(echo),
        verdict: "CHALLENGE",
      });
    const wrongPackets: Record<string, string>[] = [
      { commit: "d".repeat(40) },
      { document_id: "doc-2" },
      { document_updated_at: "2026-10-27T09:00:00.000Z" },
    ];
    for (const echo of wrongPackets) {
      assert.equal(
        criticVerdictFields("completed", challenge(echo), PACKET).counted,
        "failed",
        JSON.stringify(echo)
      );
    }
    const rounds = settle(wrongPackets.slice(0, 2).map(challenge));
    assert.equal(criticBlocked(rounds, "ENG-1"), false);
    assert.equal(
      criticVerdictFields("completed", challenge({}), null).counted,
      "failed"
    );
  });

  it("reads the packet the critic was sent from its message", () => {
    assert.deepEqual(
      criticTaskPacket({
        message: [
          "Source issue: ENG-1",
          "Document: doc-1",
          "Document updatedAt: `2026-10-27T10:00:00.000Z`",
          `**Commit**: ${COMMIT}`,
          "Review kind: duplicate: r",
        ].join("\n"),
      }),
      PACKET
    );
    assert.deepEqual(
      criticTaskPacket({
        message: `Source issue: ENG-1\nDocument: read-only\nDocument updatedAt: read-only\nCommit: ${COMMIT}`,
      }),
      { ...PACKET, documentId: "read-only", updatedAt: "read-only" }
    );
    assert.deepEqual(
      criticTaskPacket({ message: "Source issue: ENG-1\nPlease review." }),
      { commit: null, documentId: null, issue: "ENG-1", updatedAt: null }
    );
    assert.equal(criticTaskPacket({ message: "Please review ENG-1." }), null);
  });

  it("treats an approval with failed criteria, blocking findings or missing slugs as an objection", () => {
    for (const output of [
      reply({ criteria_results: criteria(CRITIC_CRITERIA.length) }),
      reply({ blocking_findings: [CRITIC_FINDING] }),
      reply({ criteria_results: criteria(0, 11) }),
      reply({
        criteria_results: [...criteria(0, 11), criteria(0, 1)[0]],
      }),
    ]) {
      assert.equal(
        criticVerdictFields("completed", output, PACKET).counted,
        "objection"
      );
    }
    const challenge = reply({
      blocking_findings: [CRITIC_FINDING],
      criteria_results: criteria(1),
      verdict: "CHALLENGE",
    });
    const hollow = reply({
      blocking_findings: [CRITIC_FINDING],
      criteria_results: criteria(CRITIC_CRITERIA.length),
    });
    const rounds = settle([challenge, hollow]);
    assert.equal(rounds["ENG-1"].objections, 2);
    assert.equal(criticBlocked(rounds, "ENG-1"), true);
  });

  it("counts a result outside PASS, FAIL and NOT_APPLICABLE as a failed review, never an approval", () => {
    const unknown = criteria().map((entry, i) =>
      i === 0 ? { ...entry, result: "UNKNOWN" } : entry
    );
    const fields = criticVerdictFields(
      "completed",
      reply({ criteria_results: unknown }),
      PACKET
    );
    assert.equal(fields.counted, "failed");
    assert.equal(fields.verdict, "failed");
    assert.equal(
      criticVerdictFields(
        "completed",
        reply({
          criteria_results: criteria().map((entry, i) =>
            i === 0 ? { ...entry, result: "NOT_APPLICABLE" } : entry
          ),
        }),
        PACKET
      ).counted,
      "approve"
    );
  });

  it("keeps the raw verdict and counts for the log", () => {
    assert.deepEqual(
      criticVerdictFields("completed", skillLoadFailure, PACKET),
      {
        blockingFindings: 0,
        counted: "failed",
        failedCriteria: 0,
        verdict: "INSUFFICIENT_EVIDENCE",
      }
    );
  });
});

describe("replay results", () => {
  it("still reads a result written before the critic count was recorded", () => {
    const critic = {
      blockingFindings: 0,
      failedCriteria: 0,
      verdict: "APPROVE",
    };
    assert.equal(
      triageResultSchema.shape.critic.safeParse(critic).success,
      true
    );
  });
});

describe("the critic.verdict log line", () => {
  it("carries how the result counted", () => {
    const line = JSON.parse(
      formatOpsEvent("critic.verdict", {
        ...criticVerdictFields("completed", skillLoadFailure, PACKET),
        issue: "ENG-1",
      })
    );
    assert.equal(line.counted, "failed");
    assert.equal(line.verdict, "INSUFFICIENT_EVIDENCE");
  });
});
