import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITIC_CRITERIA } from "../subagents/critic/agent.js";
import { formatOpsEvent } from "./ops-log.js";
import {
  assigneeKind,
  BILLING_PATH,
  billingDecisionFields,
  criticTaskIssue,
  criticVerdictFields,
  criticVerdictIssue,
  decisionFields,
  routeDecisionEvent,
  settleDecision,
  settleRoute,
} from "./triage-log.js";
import { prepareReplayArchive } from "./triage-replay/archive.js";

const UNPACK = /tar -xzf .* && test ! -e \/workspace\/repo\/\.git/u;

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
      { blockingFindings: 0, failedCriteria: 0, verdict: "APPROVE" }
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
      { blockingFindings: 2, failedCriteria: 2, verdict: "CHALLENGE" }
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
        missing: ["x"],
        notes: [],
        outcome: "unproven",
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
    const billed = routeDecisionEvent(
      decisions,
      { assignee: "Aaron Fraga", issue: "ENG-9", project: "Support" },
      billing
    );
    assert.deepEqual(
      [billed.outcome, billed.code, billed.path],
      ["route", "billing", BILLING_PATH]
    );
    const other = routeDecisionEvent(
      decisions,
      { assignee: "Ada", issue: "ENG-9", project: "CRM" },
      billing
    );
    assert.equal(other.code, "skill_fallback");
    assert.equal(
      routeDecisionEvent(decisions, { issue: "ENG-2" }, billing).code,
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

  it("binds a billing decision made before its ticket exists to the first matching route only", () => {
    const pending = { assignee: "Aaron Fraga", project: "Support" };
    const first = settleRoute({}, { ...pending, issue: "ENG-20" }, pending);
    assert.equal(first.event.code, "billing");
    assert.equal(first.pendingBilling, null);
    assert.equal(first.decisions["ENG-20"].route?.project, "Support");
    const second = settleRoute(
      first.decisions,
      { ...pending, issue: "ENG-21" },
      first.pendingBilling
    );
    assert.equal(second.event.code, "skill_fallback");
    const again = settleRoute(
      first.decisions,
      { ...pending, issue: "ENG-20" },
      first.pendingBilling
    );
    assert.equal(again.event.code, "billing");
    const triaged = settleRoute(
      settleDecision({}, routed).decisions,
      { ...pending, issue: "ENG-2" },
      pending
    );
    assert.equal(triaged.event.code, null);
    assert.deepEqual(triaged.pendingBilling, pending);
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

describe("replay archive", () => {
  it("unpacks the pinned archive with no history and writes the repository marker", async () => {
    const commands: string[] = [];
    const files: Record<string, unknown> = {};
    const sandbox = {
      run: (options: { command: string }) => {
        commands.push(options.command);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
      writeBinaryFile: (o: { content: unknown; path: string }) => {
        files[o.path] = o.content;
        return Promise.resolve();
      },
      writeTextFile: (o: { content: string; path: string }) => {
        files[o.path] = o.content;
        return Promise.resolve();
      },
    } as never;
    const error = await prepareReplayArchive(
      sandbox,
      {
        commit: "a".repeat(40),
        url: "https://x.blob.vercel-storage.com/a.tgz",
      },
      () => Promise.resolve(new Uint8Array([1, 2, 3]))
    );
    assert.equal(error, null);
    assert.match(commands[0], UNPACK);
    assert.equal(
      JSON.parse(String(files["/workspace/.foreman/repository.json"]))
        .replayCommit,
      "a".repeat(40)
    );
  });
});
