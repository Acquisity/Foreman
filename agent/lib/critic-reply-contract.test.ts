import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CRITIC_CRITERIA,
  criticReplySchema,
} from "../subagents/critic/agent.js";
import { CRITIC_FINDING } from "./triage-fixtures.js";
import {
  applyCriticSettlement,
  type CriticCount,
  criticBlocked,
  criticVerdictFields,
  recordDecision,
  stampCriticPacket,
} from "./triage-log.js";

const COMMIT = "c".repeat(40);
const PACKET = {
  commit: COMMIT,
  documentId: "doc-1",
  issue: "ENG-1",
  updatedAt: "2026-10-27T10:00:00.000Z",
};
const criteria = (result: string) =>
  CRITIC_CRITERIA.map((criterion) => ({
    criterion,
    evidence: "read",
    rationale: "checked",
    result,
  }));
const valid = (verdict: string) => ({
  advisory_notes: [],
  blocking_findings: verdict === "APPROVE" ? [] : [CRITIC_FINDING],
  criteria_results: criteria(verdict === "APPROVE" ? "PASS" : "FAIL"),
  reviewed: {
    commit: COMMIT,
    document_id: "doc-1",
    document_updated_at: "2026-10-27T10:00:00.000Z",
    issue_id: "ENG-1",
  },
  summary: "s",
  verdict,
});
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const malformed = (verdict: string): [string, unknown][] => {
  const base = valid(verdict);
  const hollow = base.criteria_results;
  return [
    ["a null finding", { ...base, blocking_findings: [null] }],
    ["a string finding", { ...base, blocking_findings: ["wrong"] }],
    [
      "a finding without next_check",
      { ...base, blocking_findings: [without(CRITIC_FINDING, "next_check")] },
    ],
    [
      "a finding with an extra field",
      { ...base, blocking_findings: [{ ...CRITIC_FINDING, note: "x" }] },
    ],
    [
      "criteria without evidence",
      {
        ...base,
        criteria_results: hollow.map((entry) => without(entry, "evidence")),
      },
    ],
    [
      "criteria without rationale",
      {
        ...base,
        criteria_results: hollow.map((entry) => without(entry, "rationale")),
      },
    ],
    [
      "criteria with empty evidence",
      {
        ...base,
        criteria_results: hollow.map((entry) => ({ ...entry, evidence: " " })),
      },
    ],
    ...(
      [
        "summary",
        "advisory_notes",
        "reviewed",
        "criteria_results",
        "blocking_findings",
        "verdict",
      ] as const
    ).map((key): [string, unknown] => [`no ${key}`, without(base, key)]),
    ["an extra top-level field", { ...base, extra: true }],
    [
      "a reviewed echo without document_id",
      { ...base, reviewed: without(base.reviewed, "document_id") },
    ],
  ];
};

type CycleState = Pick<
  ReturnType<typeof applyCriticSettlement>,
  "decisions" | "rounds"
>;

const cycle = (outputs: unknown[]): CycleState =>
  outputs.reduce<CycleState>(
    (state, output) => {
      const decided = recordDecision(state.decisions, state.rounds, {
        classification: "Bug",
        closureReview: true,
        issue: "ENG-1",
        outcome: "route",
        path: "Duplicate",
      });
      const counted: CriticCount = criticVerdictFields(
        "completed",
        output,
        PACKET
      ).counted;
      return applyCriticSettlement(
        decided.decisions,
        decided.rounds,
        stampCriticPacket(decided.rounds, PACKET),
        counted
      );
    },
    { decisions: {}, rounds: {} }
  );

describe("the critic reply contract", () => {
  it("counts a complete reply by the policy", () => {
    assert.equal(
      criticVerdictFields("completed", valid("APPROVE"), PACKET).counted,
      "approve"
    );
    assert.equal(
      criticVerdictFields("completed", valid("CHALLENGE"), PACKET).counted,
      "objection"
    );
    assert.equal(
      criticBlocked(
        cycle([valid("CHALLENGE"), valid("CHALLENGE")]).rounds,
        "ENG-1"
      ),
      true
    );
  });

  it("counts a reply outside the contract as failed, so it never blocks and never approves", () => {
    for (const verdict of ["CHALLENGE", "INSUFFICIENT_EVIDENCE", "APPROVE"]) {
      for (const [name, output] of malformed(verdict)) {
        const fields = criticVerdictFields("completed", output, PACKET);
        assert.equal(fields.counted, "failed", `${verdict}: ${name}`);
        assert.equal(fields.verdict, "failed", `${verdict}: ${name}`);
        const twice = cycle([output, output]).rounds;
        assert.equal(twice["ENG-1"].objections, 0, `${verdict}: ${name}`);
        assert.equal(
          criticBlocked(twice, "ENG-1"),
          false,
          `${verdict}: ${name}`
        );
      }
    }
  });

  it("is the shape the critic's instructions name, field for field", () => {
    const instructions = readFileSync(
      new URL("../subagents/critic/instructions.md", import.meta.url),
      "utf8"
    );
    const { shape } = criticReplySchema;
    for (const key of Object.keys(shape)) {
      assert.ok(instructions.includes(`- \`${key}\``), key);
    }
    for (const key of [
      ...Object.keys(shape.reviewed.shape),
      ...Object.keys(shape.criteria_results.element.shape),
      ...Object.keys(shape.blocking_findings.element.shape),
    ]) {
      assert.ok(instructions.includes(`  - \`${key}\``), key);
    }
  });
});
