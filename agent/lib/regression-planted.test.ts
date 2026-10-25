import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { JevAnswer } from "./jev.js";
import { resolveTriage, type TriageInput } from "./jev-decisions.js";
import { regressionDocumentGaps } from "./regression-document.js";
import {
  deployment,
  deps,
  FILE,
  history,
  input,
  note,
  Origin,
  recorded,
  removeSandbox,
  sendLimit,
} from "./regression-fixtures.js";
import { runCheckRegression } from "./regression-lane.js";
import type { RegressionRecord } from "./regression-record.js";

const pick = (choice: string): JevAnswer => ({
  choice,
  probabilities: { [choice]: 0.9 },
  type: "choice",
});
const yes = (): JevAnswer => ({ probability: 0.9, type: "boolean" });
const no = (): JevAnswer => ({ probability: 0.1, type: "boolean" });

const answers: Record<string, JevAnswer> = {
  classification: pick("bug"),
  customer_saw_failure: no(),
  data_loss_or_security: no(),
  direct_evidence: yes(),
  impact: {
    probabilities: { "0": 0.05, "1": 0.8, "2": 0.1, "3": 0.05 },
    score: 0,
    type: "score",
  },
  inbox_error: no(),
  incident: pick("standard"),
  incident_impact: pick("MATERIALLY_IMPAIRED"),
  money_blocker: no(),
  path: pick("Engineering Todo"),
  project: pick("AI SDR Core"),
  verdict: pick("supported"),
  wants_limit_lifted: no(),
};

const decide = (record: RegressionRecord) => {
  const triage: TriageInput = {
    blastRadius: { countedAt: "2026-10-25", orgs: 3, query: "q", users: 4 },
    claim: "Sends stop at the wrong count.",
    codePath: { commit: record.commitRead, file: FILE, function: "limit" },
    duplicateCandidates: [],
    evidence: "Inngest run failed.",
    identifier: record.issue,
    projects: [{ name: "AI SDR Core" }],
    regression: {
      commit: record.commit,
      kind: record.kind,
      line: record.line,
      reason: record.reason,
    },
    rootCauseLabels: [],
    sourceLabels: ["Customer reported"],
  };
  const decision = resolveTriage(triage, answers);
  assert.ok(decision.outcome === "route");
  return decision;
};

const documentFor = (record: RegressionRecord, result = record.line) =>
  [
    "# Triage investigation",
    "",
    "**Ticket**: ENG-1",
    "**Classification**: Bug",
    "**Review**: Pending critic",
    "",
    "## Regression check",
    `**Deployed commit**: ${record.deployedCommit ?? "Not available: Vercel unreadable"}`,
    `**Commit read**: ${record.commitRead}`,
    `**Result**: ${result}`,
    "",
  ].join("\n");

/**
 * Proof 4 of the factory goal (ENG-16056), one predicate per planted ticket:
 * the planted repository goes through the tool path, its record routes the
 * decision, and the document that repeats the record passes the guard while a
 * document that differs by one line does not.
 */
describe("planted tickets, end to end", () => {
  after(removeSandbox);

  it("fixed on main and live: names the commit, resolves, no master, document accepted", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      20,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const earlier = origin.commit(15, note("a"), "docs: a");
    const fix = origin.commit(
      5,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    const head = origin.commit(4, note("b"), "docs: b");
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin),
        input({
          deployments: {
            current: deployment(head, 4),
            timeline: [deployment(head, 4), deployment(earlier, 15)],
          },
          labels: [
            { role: "fixed", sha: fix },
            { role: "introduced", sha: bug },
          ],
          readCommit: head,
        })
      )
    );
    assert.equal(record.line, `fixed on main and live, by ${fix}`);
    const decision = decide(record);
    assert.equal(decision.path, "Resolved by triage");
    assert.equal(decision.route.state, "Done");
    assert.notEqual(decision.path, "Engineering Todo");
    assert.deepEqual(regressionDocumentGaps(documentFor(record), record), []);
    assert.equal(
      regressionDocumentGaps(documentFor(record, "none"), record).length,
      1
    );
  });

  it("fixed on main, not deployed: goes to the owner with the commit, stays open, no master", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      20,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const served = origin.commit(15, note("served"), "docs: served");
    const fix = origin.commit(
      2,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin),
        input({
          deployments: {
            current: deployment(served, 15),
            timeline: [deployment(served, 15)],
          },
          labels: [
            { role: "fixed", sha: fix },
            { role: "introduced", sha: bug },
          ],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.line, `fixed on main, not deployed yet, by ${fix}`);
    const decision = decide(record);
    assert.equal(decision.path, "Support/Product follow-up");
    assert.equal(decision.route.state, "Todo");
    assert.equal(decision.route.assignee, "James Keeble");
    assert.ok(decision.route.addLabels.includes("Bug"));
    assert.ok(decision.notes.some((line) => line.includes(fix)));
    assert.deepEqual(regressionDocumentGaps(documentFor(record), record), []);
    assert.equal(
      regressionDocumentGaps(
        documentFor({ ...record, deployedCommit: fix }),
        record
      ).length,
      1
    );
  });

  it("regression: names the commit from the last 30 days and stays engineering work", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      10,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const head = origin.commit(9, note("after"), "docs: after");
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin),
        input({
          deployments: {
            current: deployment(head, 9),
            timeline: [deployment(head, 9)],
          },
          labels: [{ role: "introduced", sha: bug }],
          readCommit: head,
        })
      )
    );
    assert.equal(record.line, `introduced by ${bug}`);
    const decision = decide(record);
    assert.equal(decision.path, "Engineering Todo");
    assert.equal(decision.route.state, "Todo");
    assert.deepEqual(regressionDocumentGaps(documentFor(record), record), []);
  });
});
