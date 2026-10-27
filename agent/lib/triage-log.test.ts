import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITIC_CRITERIA } from "../subagents/critic/agent.js";
import { formatOpsEvent } from "./ops-log.js";
import {
  assigneeKind,
  BILLING_PATH,
  billingDecisionFields,
  blockedDecision,
  confidenceFields,
  criticBlocked,
  criticTaskIssue,
  criticVerdictFields,
  criticVerdictIssue,
  decisionFields,
  routeDecisionEvent,
  routeRefusal,
  settleCriticRound,
  settleDecision,
} from "./triage-log.js";

const FIRST_LINE_RULE = /Source issue: ENG-1/u;
const TWICE_RULE = /objected to ENG-1 twice/u;

const criteria = (fail: number) =>
  CRITIC_CRITERIA.map((criterion, i) => ({
    criterion,
    evidence: "read",
    rationale: "checked",
    result: i < fail ? "FAIL" : "PASS",
  }));

describe("critic.verdict fields", () => {
  it("counts failed criteria and blocking findings on a settled review", () => {
    assert.deepEqual(
      criticVerdictFields("completed", {
        blocking_findings: [],
        criteria_results: criteria(0),
        verdict: "APPROVE",
      }),
      {
        blockingFindings: 0,
        counted: "failed",
        failedCriteria: 0,
        verdict: "APPROVE",
      }
    );
    assert.deepEqual(
      criticVerdictFields(
        "completed",
        JSON.stringify({
          blocking_findings: [{ claim: "x" }, { claim: "y" }],
          criteria_results: criteria(2),
          verdict: "CHALLENGE",
        })
      ),
      {
        blockingFindings: 2,
        counted: "failed",
        failedCriteria: 2,
        verdict: "CHALLENGE",
      }
    );
  });

  it("reads a malformed, failed or cancelled review as failed", () => {
    for (const [status, output] of [
      ["completed", "not json"],
      ["completed", { verdict: "MAYBE" }],
      ["failed", undefined],
      ["cancelled", undefined],
    ] as const) {
      assert.equal(criticVerdictFields(status, output).verdict, "failed");
    }
  });
});

describe("triage.decision fields", () => {
  it("keeps the final decision's outcome, classification and path with the issue", () => {
    assert.deepEqual(
      decisionFields("ENG-1", {
        confidence: { classification: 0.9, path: 0.9, verdict: 0.4 },
        missing: ["x"],
        notes: [],
        outcome: "unproven",
        review: { kind: null, reason: "r", required: false },
        verdict: { confidence: 0.4, value: "unproven" },
      }),
      { classification: null, issue: "ENG-1", outcome: "unproven", path: null }
    );
    assert.equal(assigneeKind({ inheritAssigneeFrom: "ENG-2" }), "inherited");
    assert.equal(assigneeKind({ assignee: "Ada" }), "named");
    assert.equal(assigneeKind({}), "none");
  });

  it("the ops log carries the new fields and nothing else", () => {
    const line = JSON.parse(
      formatOpsEvent("triage.decision", {
        assigneeKind: "named",
        classification: "Bug",
        duplicateOf: null,
        issue: "ENG-1",
        outcome: "route",
        path: "Engineering Todo",
        project: "CRM",
        verdict: "APPROVE",
      } as never)
    );
    assert.equal(line.issue, "ENG-1");
    assert.equal(line.classification, "Bug");
    assert.equal(line.verdict, "APPROVE");
    assert.equal(
      JSON.parse(formatOpsEvent("x", { ticketText: "secret" } as never))
        .ticketText,
      undefined
    );
  });
});

describe("issue-bound decisions", () => {
  const unproven = {
    classification: null,
    issue: "ENG-1",
    outcome: "unproven" as const,
    path: null,
  };
  const routed = {
    classification: "Bug",
    issue: "ENG-2",
    outcome: "route" as const,
    path: "Engineering Todo",
  };

  it("keeps the latest decision per issue, and marks a second one for the same issue as the adjudication", () => {
    const first = settleDecision({}, unproven);
    assert.equal(first.stage, "decide");
    const second = settleDecision(first.decisions, routed);
    assert.equal(second.stage, "decide");
    const adjudicated = settleDecision(second.decisions, {
      ...routed,
      classification: "User Error",
    });
    assert.equal(adjudicated.stage, "adjudicate");
    assert.equal(adjudicated.decisions["ENG-1"].outcome, "unproven");
    assert.equal(adjudicated.decisions["ENG-2"].classification, "User Error");
  });

  it("logs a route only with the decision for the routed issue", () => {
    const { decisions } = settleDecision(
      settleDecision({}, unproven).decisions,
      routed
    );
    assert.equal(
      routeDecisionEvent(decisions, { issue: "ENG-1" }).outcome,
      "unproven"
    );
    assert.equal(
      routeDecisionEvent(decisions, { issue: "ENG-2", project: "CRM" })
        .classification,
      "Bug"
    );
  });

  it("logs a route the skill decided after Jev failed, and a decide_billing route, instead of nothing", () => {
    const { decisions } = settleDecision({}, routed);
    const fallback = routeDecisionEvent(decisions, {
      assignee: "Ada",
      issue: "ENG-9",
      project: "CRM",
    });
    assert.deepEqual(
      [
        fallback.issue,
        fallback.outcome,
        fallback.code,
        fallback.classification,
        fallback.path,
      ],
      ["ENG-9", "skill", "skill_fallback", null, null]
    );
    const billing = { assignee: "Aaron Fraga", project: "Support" };
    const withBilling = {
      ...decisions,
      "ENG-9": billingDecisionFields("ENG-9", billing),
    };
    const billed = routeDecisionEvent(withBilling, {
      assignee: "Aaron Fraga",
      issue: "ENG-9",
      project: "Support",
    });
    assert.deepEqual(
      [billed.outcome, billed.code, billed.path],
      ["route", "billing", BILLING_PATH]
    );
    const other = routeDecisionEvent(withBilling, {
      assignee: "Ada",
      issue: "ENG-9",
      project: "CRM",
    });
    assert.equal(other.code, "skill_fallback");
    assert.equal(
      routeDecisionEvent(withBilling, { issue: "ENG-2" }).code,
      null
    );
    const line = JSON.parse(formatOpsEvent("triage.decision", billed));
    assert.equal(line.code, "billing");
  });

  it("binds a billing decision to its issue, so a matching route on another issue is a fallback", () => {
    const billing = { assignee: "Aaron Fraga", project: "Support" };
    const decisions = {
      "ENG-9": billingDecisionFields("ENG-9", billing),
    };
    const route = { assignee: "Aaron Fraga", project: "Support" };
    const own = routeDecisionEvent(decisions, { ...route, issue: "ENG-9" });
    assert.deepEqual(
      [own.outcome, own.code, own.path],
      ["route", "billing", BILLING_PATH]
    );
    const other = routeDecisionEvent(decisions, { ...route, issue: "ENG-10" });
    assert.deepEqual(
      [other.outcome, other.code, other.path],
      ["skill", "skill_fallback", null]
    );
    const changed = routeDecisionEvent(decisions, {
      assignee: "Ada",
      issue: "ENG-9",
      project: "CRM",
    });
    assert.equal(changed.code, "skill_fallback");
  });

  it("lets the later of a triage and a billing decision for one issue win, in either order", () => {
    const billing = { assignee: "Aaron Fraga", project: "Support" };
    const route = { ...billing, issue: "ENG-2" };
    const triageThenBilling = {
      ...settleDecision({}, routed).decisions,
      "ENG-2": billingDecisionFields("ENG-2", billing),
    };
    const billed = routeDecisionEvent(triageThenBilling, route);
    assert.deepEqual(
      [billed.code, billed.path, billed.classification],
      ["billing", BILLING_PATH, null]
    );
    const afterBilling = settleDecision(triageThenBilling, routed);
    assert.equal(afterBilling.stage, "decide");
    const triaged = routeDecisionEvent(afterBilling.decisions, route);
    assert.deepEqual(
      [triaged.code, triaged.path, triaged.classification],
      [null, "Engineering Todo", "Bug"]
    );
  });

  it("binds a critic task to the source issue named on its dispatch's first line, never to a candidate it mentions", () => {
    const sourceAfterJevFailed = {
      message:
        "Source issue: ENG-3\nDocument d1, updatedAt 2026-10-01T10:00:00.000Z.\nMaster candidate: ENG-2, the same token refresh.",
    };
    assert.equal(criticTaskIssue(sourceAfterJevFailed), "ENG-3");
    assert.equal(
      criticTaskIssue({ message: "Review ENG-2, document d1" }),
      null
    );
    assert.equal(
      criticTaskIssue({ message: "Please review.\nSource issue: ENG-3" }),
      null
    );
    assert.equal(
      criticTaskIssue({ message: "**Source issue:** `ENG-3`.\nMore." }),
      "ENG-3"
    );
    assert.equal(criticTaskIssue({ message: 42 }), null);
    assert.equal(criticVerdictIssue({ c1: "ENG-3" }, "c1"), "ENG-3");
    assert.equal(criticVerdictIssue({ c1: "ENG-3" }, "c2"), null);
  });
});

describe("the critic's second check", () => {
  const duplicate = {
    classification: "Bug",
    closureReview: true,
    issue: "ENG-1",
    outcome: "route" as const,
    path: "Duplicate",
  };
  const bug = {
    classification: "Bug",
    closureReview: false,
    issue: "ENG-2",
    outcome: "route" as const,
    path: "Engineering Todo",
  };
  const routeInput = {
    duplicateOf: "ENG-9",
    issue: "ENG-1",
    state: "Duplicate",
  };

  it("marks a closure for review and carries confidence and review into the log", () => {
    const fields = decisionFields("ENG-1", {
      approval: "not-applicable",
      area: null,
      assignee: "James Keeble",
      classification: "Bug",
      confidence: { classification: 0.7, path: 0.85, verdict: 0.9 },
      needsCriticReview: true,
      notes: [],
      outcome: "route",
      path: "Duplicate",
      review: { kind: "duplicate", reason: "r", required: true },
      route: { addLabels: [], priority: 2, state: "Duplicate" },
      verdict: { confidence: 0.9, value: "supported" },
    });
    assert.equal(fields.closureReview, true);
    const bugFields = decisionFields("ENG-2", {
      approval: "not-applicable",
      area: null,
      assignee: "James Keeble",
      classification: "Bug",
      confidence: { classification: 0.7, path: 0.85, verdict: 0.9 },
      needsCriticReview: true,
      notes: [],
      outcome: "route",
      path: "Engineering Todo",
      review: { kind: "bug", reason: "r", required: true },
      route: { addLabels: [], priority: 3, state: "Todo" },
      verdict: { confidence: 0.9, value: "supported" },
    });
    assert.equal(bugFields.closureReview, false);
    const line = JSON.parse(
      formatOpsEvent("triage.decision", {
        ...confidenceFields({
          confidence: { classification: 0.7, path: 0.85, verdict: 0.9 },
          missing: [],
          notes: [],
          outcome: "unproven",
          review: { kind: null, reason: "r", required: false },
          verdict: { confidence: 0.9, value: "supported" },
        }),
        issue: "ENG-1",
      })
    );
    assert.equal(line.verdictConfidence, 0.9);
    assert.equal(line.classificationConfidence, 0.7);
    assert.equal(line.pathConfidence, 0.85);
    assert.equal(line.reviewRequired, false);
  });

  it("holds a closure or duplicate from routing until the critic has settled", () => {
    const decisions = { "ENG-1": duplicate, "ENG-2": bug };
    assert.match(
      routeRefusal(decisions, {}, routeInput) ?? "",
      FIRST_LINE_RULE
    );
    for (const verdict of ["approve", "objection", "failed"] as const) {
      const rounds = settleCriticRound({}, "ENG-1", verdict);
      assert.equal(routeRefusal(decisions, rounds, routeInput), null, verdict);
    }
    assert.equal(
      routeRefusal(decisions, {}, { issue: "ENG-2", state: "Todo" }),
      null
    );
  });

  it("blocks routing after a second objection and still allows the owner assignment", () => {
    const decisions = { "ENG-1": duplicate };
    const first = settleCriticRound({}, "ENG-1", "objection");
    assert.equal(criticBlocked(first, "ENG-1"), false);
    assert.equal(routeRefusal(decisions, first, routeInput), null);
    const second = settleCriticRound(first, "ENG-1", "objection");
    assert.equal(criticBlocked(second, "ENG-1"), true);
    assert.match(routeRefusal(decisions, second, routeInput) ?? "", TWICE_RULE);
    assert.match(
      routeRefusal({}, second, { issue: "ENG-1", labels: ["Bug"] }) ?? "",
      TWICE_RULE
    );
    assert.equal(
      routeRefusal(decisions, second, { assignee: "Ada", issue: "ENG-1" }),
      null
    );
    assert.equal(
      routeRefusal(decisions, second, {
        assignee: "Ada",
        issue: "ENG-1",
        state: undefined,
      }),
      null
    );
  });

  it("clears the objections on an approval and does not count a failed review as one", () => {
    const first = settleCriticRound({}, "ENG-1", "objection");
    const failed = settleCriticRound(first, "ENG-1", "failed");
    assert.equal(failed["ENG-1"].objections, 1);
    assert.equal(criticBlocked(failed, "ENG-1"), false);
    const approved = settleCriticRound(first, "ENG-1", "approve");
    assert.equal(approved["ENG-1"].objections, 0);
    const again = settleCriticRound(approved, "ENG-1", "objection");
    assert.equal(criticBlocked(again, "ENG-1"), false);
    assert.equal(
      criticBlocked(settleCriticRound(failed, "ENG-1", "objection"), "ENG-1"),
      true
    );
  });

  it("records a blocked ticket as unproven in the live log, with the owner assignment logged as such", () => {
    const decisions = { "ENG-1": duplicate, "ENG-2": bug };
    const once = settleCriticRound({}, "ENG-1", "objection");
    assert.equal(blockedDecision(decisions, once, "ENG-1")["ENG-1"], duplicate);
    const twice = settleCriticRound(once, "ENG-1", "objection");
    const blocked = blockedDecision(decisions, twice, "ENG-1");
    assert.deepEqual(blocked["ENG-1"], {
      classification: null,
      issue: "ENG-1",
      outcome: "unproven",
      path: null,
    });
    assert.equal(blocked["ENG-2"], bug);
    const event = routeDecisionEvent(blocked, {
      assignee: "Ada",
      issue: "ENG-1",
    });
    assert.equal(event.outcome, "unproven");
    assert.equal(event.path, null);
    assert.equal(event.classification, null);
  });

  it("keeps each issue's objections apart", () => {
    const rounds = settleCriticRound(
      settleCriticRound({}, "ENG-1", "objection"),
      "ENG-2",
      "objection"
    );
    assert.equal(criticBlocked(rounds, "ENG-1"), false);
    assert.equal(criticBlocked(rounds, "ENG-2"), false);
  });
});
