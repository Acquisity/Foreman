import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { resolveTriage } from "./jev-decisions.js";
import { regressionDocumentGaps } from "./regression-document.js";
import {
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
import { bugAnswers, triageInput } from "./triage-fixtures.js";

const decide = (record: RegressionRecord) => {
  const decision = resolveTriage(
    triageInput({
      codePath: {
        commit: record.commitRead,
        file: FILE,
        function: record.function,
        lines: record.lines,
      },
      identifier: record.issue,
      regression: {
        commit: record.commit,
        kind: record.kind,
        line: record.line,
        reason: record.reason,
      },
    }),
    bugAnswers()
  );
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
    `**Deployed commit**: ${record.deployedCommit ?? "Not available: production unreadable"}`,
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
    origin.commit(15, note("a"), "docs: a");
    const fix = origin.commit(
      5,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    const head = origin.commit(4, note("b"), "docs: b");
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin, head),
        input({
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
        deps(origin.clone(50), origin, served),
        input({
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
        deps(origin.clone(50), origin, head),
        input({
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
