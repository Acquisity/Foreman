import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCase, makeLabel, makeResult } from "./fixtures.js";
import { NEW_MASTER, triageLabelSchema } from "./schema.js";
import {
  checkScoreInput,
  expectedMaster,
  fieldMatches,
  renderScorecard,
  type ScoreInput,
  sameDuplicates,
  scoreReplay,
} from "./score.js";

const NO_LABEL = /no label: ENG-4/;
const TWO_RUN_IDS = /more than one run id/;
const REPEATED = /same case and run: ENG-1#1/;
const OUTSIDE = /outside the cohort: ENG-99/;
const MIXED_COMMITS = /more than one Foreman commit: /;
const UNKNOWN_COMMIT = /unknown Foreman commit.*: ENG-1#1/;
const ABOVE_RUNS = /runs above --runs 1: ENG-1#2/;
const RUNS_FLOOR = /--runs must be a whole number of at least 1/;
const WRONG_SPLIT = /wrong split: ENG-3/;
const HELDOUT_HEADING = /## Held-out/;
const OUTCOME_REQUIRED = /when its human outcome happened/;

const base = (overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  cases: [
    makeCase("ENG-1"),
    makeCase("ENG-2"),
    makeCase("ENG-3", { lane: "slack" }),
    makeCase("ENG-4"),
    makeCase("ENG-5"),
    makeCase("ENG-6", { lane: "slack" }),
  ],
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

test("a missing result, a failed run and a cancelled run each score wrong and show in completion", () => {
  const input = base();
  input.results = [
    makeResult("ENG-1"),
    makeResult("ENG-3", { status: "failed" }),
    makeResult("ENG-4", { status: "cancelled" }),
    makeResult("ENG-5", { status: "cancelled" }),
    makeResult("ENG-6"),
  ];
  const { train, heldout } = scoreReplay(input).splits;
  assert.deepEqual(train.all.completion, {
    cancelled: 1,
    completed: 1,
    failed: 1,
    missing: 1,
  });
  for (const tally of Object.values(train.all.fields)) {
    assert.deepEqual(tally, { correct: 1, total: 4 });
  }
  assert.equal(heldout.all.completion.cancelled, 1);
  assert.deepEqual(heldout.all.fields.verdict, { correct: 1, total: 2 });
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

test("refuses results from different Foreman commits, and reports the commit", () => {
  const mixed = base({
    results: [
      ...base().results.slice(1),
      makeResult("ENG-1", { foremanCommit: "2".repeat(40) }),
    ],
  });
  assert.throws(() => scoreReplay(mixed), MIXED_COMMITS);
  assert.throws(
    () =>
      scoreReplay(
        base({
          results: base().results.map((result) => ({
            ...result,
            foremanCommit: "unknown",
          })),
        })
      ),
    UNKNOWN_COMMIT
  );
  assert.throws(() => checkScoreInput(mixed), MIXED_COMMITS);
  const card = renderScorecard(scoreReplay(base()));
  assert.ok(card.includes(`Foreman commit ${"1".repeat(40)}`));
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
