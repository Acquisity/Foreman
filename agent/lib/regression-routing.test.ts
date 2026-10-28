import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTriage } from "./jev-decisions.js";
import { recordFor } from "./regression-record.js";
import { REGRESSION_GAP } from "./regression-routing.js";
import { bugAnswers, pick, triageInput } from "./triage-fixtures.js";

const FIX = "b".repeat(40);
const CHECK_REGRESSION = /check_regression/u;

test("a Bug main already fixes and production serves ends Done, with no engineering", () => {
  const decision = resolveTriage(
    triageInput({
      regression: {
        commit: FIX,
        kind: "fixed_live",
        line: `fixed on main and live, by ${FIX}`,
      },
    }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Resolved by triage");
  assert.equal(decision.route.state, "Done");
  assert.equal(decision.route.priority, 4);
  assert.equal(decision.route.assignee, undefined);
  assert.equal(decision.needsCriticReview, true);
  assert.ok(decision.notes.some((note) => note.includes(FIX)));
});

test("a Bug main fixes but production does not serve yet goes to the area owner and stays open", () => {
  for (const kind of ["fixed_not_deployed", "fixed_deploy_unknown"] as const) {
    const decision = resolveTriage(
      triageInput({
        regression: { commit: FIX, kind, line: `${kind} by ${FIX}` },
      }),
      bugAnswers()
    );
    assert.ok(decision.outcome === "route", kind);
    assert.equal(decision.path, "Support/Product follow-up", kind);
    assert.equal(decision.route.state, "Todo", kind);
    assert.equal(decision.assignee, "James Keeble", kind);
    assert.equal(decision.route.assignee, "James Keeble", kind);
    assert.ok(decision.route.addLabels.includes("Bug"), kind);
    assert.ok(decision.route.addLabels.includes("Area: AI SDR"), kind);
    assert.equal(decision.route.priority, 3, kind);
    assert.ok(
      decision.notes.some((note) => note.includes(FIX)),
      kind
    );
  }
});

test("a regression, no change in 30 days, or an unchecked lane leaves the engineering path alone", () => {
  const engineering = resolveTriage(triageInput(), bugAnswers());
  assert.ok(engineering.outcome === "route");
  for (const regression of [
    { commit: FIX, kind: "introduced", line: `introduced by ${FIX}` },
    { kind: "none", line: "none" },
    {
      kind: "unchecked",
      line: "unchecked: no git history",
      reason: "no git history",
    },
  ] as const) {
    const decision = resolveTriage(triageInput({ regression }), bugAnswers());
    assert.ok(decision.outcome === "route", regression.kind);
    assert.equal(decision.path, "Engineering Todo", regression.kind);
    assert.deepEqual(decision.route, engineering.route, regression.kind);
  }
});

test("a Bug with no regression check is not a Bug yet", () => {
  const decision = resolveTriage(
    triageInput({ regression: undefined }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "unproven");
  assert.deepEqual(decision.missing, [REGRESSION_GAP]);
  assert.match(REGRESSION_GAP, CHECK_REGRESSION);
});

test("the regression result changes nothing for a duplicate or a non-Bug", () => {
  const fixed = {
    commit: FIX,
    kind: "fixed_live",
    line: `fixed on main and live, by ${FIX}`,
  } as const;
  const duplicate = resolveTriage(
    triageInput({
      duplicateCandidates: [{ identifier: "ENG-9", summary: "s", title: "t" }],
      regression: fixed,
    }),
    bugAnswers({ duplicate_0: pick("same_outcome", 0.9) })
  );
  assert.ok(duplicate.outcome === "route");
  assert.equal(duplicate.path, "Duplicate");

  const userError = resolveTriage(
    triageInput({ regression: fixed }),
    bugAnswers({ classification: pick("user_error"), path: pick("User Error") })
  );
  assert.ok(userError.outcome === "route");
  assert.equal(userError.path, "User Error");
});

test("a record for any other checked target is stale evidence, so the Bug needs a new check", () => {
  const read = "a".repeat(40);
  const lines = { end: 7, start: 5 };
  const record = {
    commit: FIX,
    commitRead: read,
    deployedCommit: read,
    file: "webhook.ts",
    function: "handleReply",
    issue: "ENG-1",
    kind: "fixed_live" as const,
    line: `fixed on main and live, by ${FIX}`,
    lines,
    windowDays: 30,
  };
  const codePath = {
    commit: read,
    file: "webhook.ts",
    function: "handleReply",
    lines,
  };
  assert.equal(recordFor(record, codePath), record);
  for (const corrected of [
    { ...codePath, file: "inbox.ts" },
    { ...codePath, commit: "c".repeat(40) },
    { ...codePath, function: "parseReply" },
    { ...codePath, lines: { end: 30, start: 20 } },
    { commit: read, file: "webhook.ts", function: "handleReply" },
    undefined,
  ]) {
    const kept = recordFor(record, corrected);
    assert.equal(kept, undefined, JSON.stringify(corrected));
    const decision = resolveTriage(
      triageInput({
        ...(corrected ? { codePath: corrected } : {}),
        regression: kept,
      }),
      bugAnswers()
    );
    assert.ok(decision.outcome === "unproven");
    assert.deepEqual(decision.missing, [REGRESSION_GAP]);
  }
});
