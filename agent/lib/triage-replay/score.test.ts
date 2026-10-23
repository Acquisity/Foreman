import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCase, makeLabel, makeResult, SHA } from "./fixtures.js";
import { findLeaks, type LeakageHit } from "./leakage.js";
import { NEW_MASTER, triageLabelSchema } from "./schema.js";
import {
  APART,
  checkScoreInput,
  cohortSha256,
  expectedMaster,
  fieldMatches,
  judgeableRows,
  type RootCauseGrade,
  renderScorecard,
  rowKey,
  type ScoreInput,
  SUSPECT_EXIT_CODE,
  sameDuplicates,
  scoreReplay,
  scorerExitCode,
} from "./score.js";

const OTHER_COHORT = /different cohort/;
const NO_LABEL = /no label: ENG-4/;
const TWO_RUN_IDS = /more than one run id/;
const REPEATED = /same case and run: ENG-1#1/;
const OUTSIDE = /outside the cohort: ENG-99/;
const MIXED_COMMITS = /more than one Foreman commit: /;
const ABOVE_RUNS = /runs above --runs 1: ENG-1#2/;
const RUNS_FLOOR = /--runs must be a whole number of at least 1/;
const WRONG_SPLIT = /wrong split: ENG-3/;
const NOT_JUDGED = /not judged/;
const HELDOUT_HEADING = /## Held-out/;
const MEMBERSHIP_APART = /\| frozen list entry with no creation time \| 2 \|/;
const OUTCOME_REQUIRED = /when its human outcome happened/;
const APART_HEADING = /\| needs production data \| 1 \|/;

const leak: LeakageHit = {
  availableAt: null,
  kind: "fix_commit",
  match: "abcdef1",
  source: "linear.issue",
};

/** Four train cases, two held-out, every train run otherwise correct. */
const base = (overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  cases: [
    makeCase("ENG-1"),
    makeCase("ENG-2"),
    makeCase("ENG-3", { lane: "slack" }),
    makeCase("ENG-4"),
    makeCase("ENG-5"),
    makeCase("ENG-6", { lane: "slack" }),
  ],
  cohortSha256: SHA,
  heldoutLabels: [makeLabel("ENG-5"), makeLabel("ENG-6")],
  results: [
    makeResult("ENG-1"),
    makeResult("ENG-2"),
    makeResult("ENG-3"),
    makeResult("ENG-4"),
    makeResult("ENG-5"),
    makeResult("ENG-6"),
  ],
  split: {
    groups: {},
    heldout: ["ENG-5", "ENG-6"],
    train: ["ENG-1", "ENG-2", "ENG-3", "ENG-4"],
  },
  trainLabels: ["ENG-1", "ENG-2", "ENG-3", "ENG-4"].map((id) => makeLabel(id)),
  ...overrides,
});

test("a missing result, a failed run and a boundary error each score wrong and show in completion", () => {
  const input = base();
  input.results = [
    makeResult("ENG-1"),
    makeResult("ENG-3", { status: "failed" }),
    makeResult("ENG-4", { status: "boundary_error" }),
    makeResult("ENG-5", { status: "cancelled" }),
    makeResult("ENG-6"),
  ];
  const { train, heldout } = scoreReplay(input).splits;
  assert.deepEqual(train.all.completion, {
    boundary_error: 1,
    cancelled: 0,
    completed: 1,
    failed: 1,
    missing: 1,
  });
  // The failed and boundary-error rows carry a correct final decision; it still scores wrong.
  for (const tally of Object.values(train.all.fields)) {
    assert.deepEqual(tally, { correct: 1, total: 4 });
  }
  assert.equal(heldout.all.completion.cancelled, 1);
  assert.deepEqual(heldout.all.fields.verdict, { correct: 1, total: 2 });
});

test("a leak-suspect case is left out of the main rows and scored apart", () => {
  const report = scoreReplay(
    base({ leakage: new Map([[rowKey("ENG-1", 1), [leak]]]) })
  );
  const { train } = report.splits;
  assert.equal(train.all.rows, 3);
  assert.equal(train.apart.leak_suspect.rows, 1);
  assert.equal(train.apart.leak_suspect.leaked, 1);
  for (const tally of Object.values(train.all.fields)) {
    assert.deepEqual(tally, { correct: 3, total: 3 });
  }
  assert.deepEqual(report.suspects, { cases: ["ENG-1"], rows: 1 });
  assert.deepEqual(report.leakage, [{ caseId: "ENG-1", hits: [leak], run: 1 }]);
});

test("the scorecard prints the suspect count and the score with suspects as failures and as passes", () => {
  const card = renderScorecard(
    scoreReplay(base({ leakage: new Map([[rowKey("ENG-1", 1), [leak]]]) }))
  );
  const row = (name: string, bound: string, value: string) =>
    `| ${name} | suspects as ${bound} | ${new Array(7).fill(value).join(" | ")} |`;
  assert.ok(card.includes("## Leak-suspect cases: 1"));
  assert.ok(card.includes("- ENG-1#1: fix_commit in linear.issue"));
  assert.ok(card.includes(row("train", "failures", "75.0% (3/4)")));
  assert.ok(card.includes(row("train", "passes", "100.0% (4/4)")));
  assert.ok(card.includes(row("heldout", "failures", "100.0% (2/2)")));
  assert.ok(card.includes(row("heldout", "passes", "100.0% (2/2)")));
});

test("held-out leakage hits keep kind and source but drop the matched text", () => {
  const report = scoreReplay(
    base({ leakage: new Map([[rowKey("ENG-5", 1), [leak]]]) })
  );
  assert.deepEqual(report.leakage[0].hits, [{ ...leak, match: "" }]);
  assert.equal(report.splits.heldout.apart.leak_suspect.leaked, 1);
  assert.deepEqual(report.splits.heldout.bounds.asFailures.verdict, {
    correct: 1,
    total: 2,
  });
  assert.deepEqual(report.splits.heldout.bounds.asPasses.verdict, {
    correct: 2,
    total: 2,
  });
});

test("every run of every case is a row, so a missing second run counts", () => {
  const input = base();
  input.results = [
    ...input.results,
    makeResult("ENG-1", { run: 2 }),
    makeResult("ENG-2", { run: 2 }),
  ];
  const { train } = scoreReplay(input).splits;
  assert.equal(train.all.rows, 8);
  assert.equal(train.all.completion.missing, 2);
  assert.deepEqual(train.all.fields.verdict, { correct: 6, total: 8 });
  assert.equal(scoreReplay({ ...base(), runs: 3 }).splits.train.all.rows, 12);
});

test("scores every run number the results hold, and refuses a run count that would drop one", () => {
  const input = base({
    results: [
      ...base().results,
      makeResult("ENG-1", { run: 2, status: "failed" }),
    ],
  });
  const inferred = scoreReplay(input);
  assert.equal(inferred.runs, 2);
  assert.equal(inferred.splits.train.all.completion.failed, 1);
  assert.equal(scoreReplay({ ...input, runs: 2 }).splits.train.all.rows, 8);
  assert.throws(() => scoreReplay({ ...input, runs: 1 }), ABOVE_RUNS);
  assert.throws(() => checkScoreInput({ ...input, runs: 1 }), ABOVE_RUNS);
  assert.throws(() => scoreReplay({ ...base(), runs: 0 }), RUNS_FLOOR);
  assert.throws(() => checkScoreInput({ ...base(), runs: 1.5 }), RUNS_FLOOR);
});

test("refuses results from different Foreman commits, and reports the commit, start times and estimated cost", () => {
  const mixed = base({
    results: [
      ...base().results.slice(1),
      makeResult("ENG-1", { foremanCommit: "2".repeat(40) }),
    ],
  });
  assert.throws(() => scoreReplay(mixed), MIXED_COMMITS);
  assert.throws(() => checkScoreInput(mixed), MIXED_COMMITS);
  const timed = base({
    results: base().results.map((result, index) => ({
      ...result,
      startedAt: `2026-09-01T10:0${index}:00.000Z`,
    })),
  });
  const { foreman } = scoreReplay(timed);
  assert.deepEqual(foreman, {
    commit: "1".repeat(40),
    estimatedUsd: 24,
    firstStartedAt: "2026-09-01T10:00:00.000Z",
    lastStartedAt: "2026-09-01T10:05:00.000Z",
  });
  const card = renderScorecard(scoreReplay(timed));
  assert.ok(card.includes(`Foreman commit ${"1".repeat(40)}`));
  assert.ok(card.includes("estimated $24.00"));
});

test("insufficient labels are counted apart and left out of every score", () => {
  const input = base();
  input.trainLabels = input.trainLabels.map((label) =>
    label.id === "ENG-2" ? { ...label, insufficient: true } : label
  );
  input.results = input.results.filter(({ caseId }) => caseId !== "ENG-2");
  const { all } = scoreReplay(input).splits.train;
  assert.equal(all.insufficient, 1);
  assert.equal(all.completion.missing, 1);
  assert.deepEqual(all.fields.owner, { correct: 3, total: 3 });
});

test("train and held-out score apart, each split by intake lane", () => {
  const input = base();
  input.results = input.results.map((result) =>
    result.caseId === "ENG-3" && result.final
      ? { ...result, final: { ...result.final, project: "Billing" } }
      : result
  );
  const report = scoreReplay(input);
  assert.deepEqual(Object.keys(report.splits.train.lanes).sort(), [
    "asks",
    "slack",
  ]);
  assert.deepEqual(report.splits.train.lanes.slack.fields.project, {
    correct: 0,
    total: 1,
  });
  assert.deepEqual(report.splits.train.lanes.asks.fields.project, {
    correct: 3,
    total: 3,
  });
  assert.equal(report.splits.heldout.all.rows, 2);
  const card = renderScorecard(report);
  assert.match(card, HELDOUT_HEADING);
  assert.match(card, NOT_JUDGED);
});

test("refuses when any result was run against a different cohort", () => {
  const input = base();
  input.results = [
    ...input.results.slice(1),
    makeResult("ENG-1", { cohortSha256: "b".repeat(64) }),
  ];
  assert.throws(() => scoreReplay(input), OTHER_COHORT);
  assert.throws(() => checkScoreInput(input), OTHER_COHORT);
});

test("refuses results, splits and labels that disagree instead of dropping cases", () => {
  assert.throws(
    () => scoreReplay(base({ trainLabels: base().trainLabels.slice(0, 3) })),
    NO_LABEL
  );
  assert.throws(
    () =>
      scoreReplay(
        base({
          results: [
            ...base().results,
            makeResult("ENG-1", { run: 2, runId: "run-2" }),
          ],
        })
      ),
    TWO_RUN_IDS
  );
  assert.throws(
    () =>
      scoreReplay(base({ results: [...base().results, makeResult("ENG-1")] })),
    REPEATED
  );
  assert.throws(
    () =>
      scoreReplay(base({ results: [...base().results, makeResult("ENG-99")] })),
    OUTSIDE
  );
  assert.throws(
    () =>
      scoreReplay(
        base({ heldoutLabels: [...base().heldoutLabels, makeLabel("ENG-3")] })
      ),
    WRONG_SPLIT
  );
});

test("cohort hash depends on file names and bytes, not their order", () => {
  const files = [
    { content: '{"id":1}', name: "ENG-1.json" },
    { content: '{"id":2}', name: "ENG-2.json" },
  ];
  const sha = cohortSha256(files);
  assert.equal(sha, cohortSha256([...files].reverse()));
  assert.notEqual(
    sha,
    cohortSha256([files[0], { ...files[1], content: '{"id":3}' }])
  );
  assert.notEqual(sha, cohortSha256([files[0]]));
});

test("owner and text fields match trimmed and case-folded, and a null label field is unscored", () => {
  const label = makeLabel("ENG-1", {
    classification: null,
    owner: "Area Owner",
  });
  const final = {
    assignee: " area owner ",
    classification: "Bug",
    duplicateOf: null,
    master: "ENG-0",
    outcome: "route" as const,
    path: "FIX",
    project: "platform",
  };
  assert.deepEqual(fieldMatches(label, final), {
    classification: null,
    duplicate: true,
    master: true,
    owner: true,
    path: true,
    project: true,
    verdict: true,
  });
  assert.equal(
    fieldMatches(label, { ...final, assignee: "Pat Doe" }).owner,
    false
  );
  assert.equal(
    fieldMatches(makeLabel("ENG-1", { owner: null }), final).owner,
    null
  );
  assert.equal(
    fieldMatches(makeLabel("ENG-1"), { ...final, duplicateOf: "ENG-9" })
      .duplicate,
    false
  );
});

test("a routed answer to a label with no classification is left out of that field, not scored wrong", () => {
  const input = base();
  input.trainLabels = input.trainLabels.map((label) =>
    label.id === "ENG-1"
      ? { ...label, classification: null, path: "Support/Financial" }
      : label
  );
  input.results = input.results.map((result) =>
    result.caseId === "ENG-1" && result.final
      ? {
          ...result,
          final: {
            ...result.final,
            classification: "Bug",
            path: "Support/Financial",
          },
        }
      : result
  );
  const { fields } = scoreReplay(input).splits.train.all;
  assert.deepEqual(fields.classification, { correct: 3, total: 3 });
  assert.deepEqual(fields.path, { correct: 4, total: 4 });
});

test("master choice is scored: an older master is reused, a later one means a new master", () => {
  assert.equal(
    expectedMaster(makeLabel("ENG-10", { master: "ENG-4" })),
    "ENG-4"
  );
  assert.equal(
    expectedMaster(makeLabel("ENG-10", { master: "ENG-12" })),
    NEW_MASTER
  );
  assert.equal(expectedMaster(makeLabel("ENG-10", { master: null })), null);
  const input = base();
  input.trainLabels = input.trainLabels.map((label) =>
    label.id === "ENG-1" ? { ...label, master: "ENG-12" } : label
  );
  const wrongMaster = scoreReplay(input).splits.train.all.fields.master;
  assert.deepEqual(wrongMaster, { correct: 3, total: 4 });
  input.results = input.results.map((result) =>
    result.caseId === "ENG-1" && result.final
      ? { ...result, final: { ...result.final, master: NEW_MASTER } }
      : result
  );
  assert.deepEqual(scoreReplay(input).splits.train.all.fields.master, {
    correct: 4,
    total: 4,
  });
});

test("duplicates match as sets, with null and empty the same", () => {
  assert.equal(sameDuplicates(null, null), true);
  assert.equal(sameDuplicates([], null), true);
  assert.equal(sameDuplicates(["ENG-7"], "eng-7"), true);
  assert.equal(sameDuplicates(["ENG-7", "ENG-8"], "ENG-8, ENG-7"), true);
  assert.equal(sameDuplicates(["ENG-7", "ENG-8"], "ENG-7"), false);
  assert.equal(sameDuplicates(null, "ENG-7"), false);
});

test("root cause uses the judge's grades; unjudged rows and failed runs are wrong", () => {
  const input = base();
  input.results = input.results.filter(({ caseId }) => caseId !== "ENG-4");
  input.trainLabels = input.trainLabels.map((label) =>
    label.id === "ENG-3" ? { ...label, rootCause: null } : label
  );
  input.rootCauseGrades = new Map<string, RootCauseGrade>([
    [rowKey("ENG-1", 1), "match"],
    [rowKey("ENG-2", 1), "partial"],
    [rowKey("ENG-4", 1), "match"],
  ]);
  const { all } = scoreReplay(input).splits.train;
  // ENG-3 has no labelled root cause; ENG-4 has a grade but no result.
  assert.deepEqual(all.rootCause, { match: 1, partial: 1, total: 3, wrong: 1 });
  assert.equal(scoreReplay(base()).splits.train.all.rootCause, null);
});

test("only completed, leak-free rows with a labelled root cause and a document need the judge", () => {
  const labels = new Map(
    [
      makeLabel("ENG-1"),
      makeLabel("ENG-2", { rootCause: null }),
      makeLabel("ENG-3", { insufficient: true }),
      makeLabel("ENG-4"),
      makeLabel("ENG-5"),
      makeLabel("ENG-6"),
    ].map((label) => [label.id, label])
  );
  const rows = judgeableRows(
    [
      makeResult("ENG-1"),
      makeResult("ENG-2"),
      makeResult("ENG-3"),
      makeResult("ENG-4", { status: "failed" }),
      makeResult("ENG-5", { document: null }),
      makeResult("ENG-6"),
    ],
    labels,
    new Map([[rowKey("ENG-6", 1), [leak]]])
  );
  assert.deepEqual(
    rows.map(({ caseId }) => caseId),
    ["ENG-1"]
  );
});

test("cases that need production data score apart, never in the main rows", () => {
  const input = base();
  input.cases = input.cases.map((item) =>
    item.id === "ENG-2"
      ? { ...item, flags: { ...item.flags, needsProductionData: true } }
      : item
  );
  input.results = input.results.filter((result) => result.caseId !== "ENG-2");
  const { train } = scoreReplay(input).splits;
  assert.equal(train.all.rows, 3);
  assert.deepEqual(train.all.fields.verdict, { correct: 3, total: 3 });
  assert.equal(train.apart.needs_production_data.rows, 1);
  assert.equal(train.apart.needs_production_data.completion.missing, 1);
  assert.match(renderScorecard(scoreReplay(input)), APART_HEADING);
});

test("an edited description scores apart before the production-data group, and a young human outcome stays in the main rows", () => {
  const input = base();
  input.cases = input.cases.map((item) =>
    item.id === "ENG-1"
      ? {
          ...item,
          flags: {
            ...item.flags,
            descriptionEditedAfterCreate: true,
            needsProductionData: true,
          },
        }
      : item
  );
  input.trainLabels = input.trainLabels.map((label) =>
    label.id === "ENG-2" || label.id === "ENG-3"
      ? { ...label, outcomeAt: "2026-10-22T09:00:00.000Z" }
      : label
  );
  const { train } = scoreReplay(input).splits;
  assert.deepEqual(
    [...APART],
    [
      "edited_after_create",
      "list_membership_unknown",
      "needs_production_data",
      "leak_suspect",
    ]
  );
  assert.equal(train.apart.edited_after_create.rows, 1);
  assert.equal(train.apart.needs_production_data.rows, 0);
  assert.equal(train.all.rows, 3);
  assert.deepEqual(train.all.fields.verdict, { correct: 3, total: 3 });
});

test("a label with ground truth says when its human outcome happened", () => {
  assert.throws(
    () => triageLabelSchema.parse({ ...makeLabel("ENG-9"), outcomeAt: null }),
    OUTCOME_REQUIRED
  );
  assert.equal(
    triageLabelSchema.parse({
      ...makeLabel("ENG-9"),
      insufficient: true,
      outcomeAt: null,
    }).outcomeAt,
    null
  );
});

test("a case whose run answered from a frozen list entry with no creation time scores apart, every run of it", () => {
  const input = base({ runs: 2 });
  input.results = [
    ...input.results.map((result) =>
      result.caseId === "ENG-1"
        ? { ...result, listMembershipUnknown: ["labels" as const] }
        : result
    ),
    makeResult("ENG-1", { run: 2 }),
  ];
  const report = scoreReplay(input);
  const { train } = report.splits;
  assert.equal(train.apart.list_membership_unknown.rows, 2);
  assert.equal(train.apart.list_membership_unknown.listMembershipUnknown, 1);
  assert.equal(train.all.listMembershipUnknown, 0);
  assert.equal(train.all.rows, 3 * 2);
  assert.match(renderScorecard(report), MEMBERSHIP_APART);
});

test("a planted fix commit, PR text or cause phrase fails the scorer with exit 3 unless suspects are allowed", () => {
  const fixCommit = "3f9c2b7d41e85a0c6b19d2e4f7a3c8b5d0e1f2a3";
  const label = makeLabel("ENG-1", { fixCommit, fixPr: 6108 });
  const pr = {
    body: "Keeps the cached layout in memory until the panel finishes its second render pass.",
    title: "Keep cached layout through panel re-render",
  };
  const exitFor = (content: string, allow: boolean) => {
    const hits = findLeaks({
      label,
      pr,
      result: {
        inputs: [
          { availableAt: null, content, provenance: "seeded", source: "bash" },
        ],
      },
    });
    const input = base({
      leakage: new Map([[rowKey("ENG-1", 1), hits]]),
    });
    input.trainLabels = input.trainLabels.map((item) =>
      item.id === "ENG-1" ? label : item
    );
    return scorerExitCode(scoreReplay(input), allow);
  };
  assert.equal(SUSPECT_EXIT_CODE, 3);
  for (const planted of [
    `commit ${fixCommit} touched the panel`,
    "Keep cached layout through panel re-render",
    "The save handler cleared the cached layout before the panel rendered it again.",
  ]) {
    assert.equal(exitFor(planted, false), 3);
    assert.equal(exitFor(planted, true), 0);
  }
  assert.equal(exitFor("nothing relevant here", false), 0);
});
