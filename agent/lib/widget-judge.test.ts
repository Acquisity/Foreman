import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import {
  claimsFor,
  JUDGE_TIMEOUT_MS,
  type JudgeRecord,
  judgeAnswer,
  judgeRecordSchema,
  parseMarks,
  parseVerdicts,
  readRecords,
  renderReview,
  reviewedSample,
  saveRecord,
} from "./widget-judge.js";

import {
  calibrated,
  type GoldEntry,
  goldSchema,
  mergeGold,
  scoreAgainstGold,
  toGold,
  writeGold,
} from "./widget-judge-calibration.js";

const GOLD_REFUSAL = /Gold not saved/;
const present = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined);
  return value;
};

const CAUSE_TEXT = /two inboxes disconnected/;
const CAUSE_ROW = /\| a#cause \| .* \| yes \| a \\\| b \| {2}\|/;
const CAUSE_MARK = /(\| a#cause \|.*\|) {2}\|/;
const ACTIONS_MARK = /(\| a#actions \|.*\|) {2}\|/;

const smoke = widgetCaseSchema.parse(
  JSON.parse(readFileSync("evals/widget/cases/local-widget-smoke.json", "utf8"))
);
// The tests set their own expectations, so editing the case file cannot break them.
const recorded: WidgetCase = {
  ...smoke,
  expectations: {
    ...smoke.expectations,
    cause: null,
    claims: [],
    foreignIdentifiers: [],
  },
};
const withRole = (
  role: WidgetCase["scope"]["role"],
  expectations: Partial<WidgetCase["expectations"]> = {}
): WidgetCase => ({
  ...recorded,
  expectations: { ...recorded.expectations, ...expectations },
  scope: { ...recorded.scope, role },
});

test("shared claims cover every answered case; the member claim only member and client", () => {
  const owner = claimsFor(withRole("owner")).map((claim) => claim.id);
  assert.deepEqual(owner, [
    "cause",
    "actions",
    "facts",
    "steps",
    "jargon",
    "caveats",
    "invented",
  ]);
  assert.ok(claimsFor(withRole("member")).some((c) => c.id === "member"));
  assert.ok(claimsFor(withRole("client")).some((c) => c.id === "member"));
  assert.ok(!claimsFor(withRole("admin")).some((c) => c.id === "member"));
  const own = claimsFor(
    withRole("owner", { cause: "two inboxes disconnected", claims: ["X"] })
  );
  assert.match(own[0]?.text ?? "", CAUSE_TEXT);
  assert.deepEqual(own.at(-1), { id: "case-1", text: "X" });
  const conversation = claimsFor({
    ...withRole("owner"),
    question:
      "LATEST CUSTOMER MESSAGE (the one to work on):\nAnd for campaigns?\n\nEARLIER TURNS (context):\nCustomer: Where is billing?\nSupport: Under Settings.",
  }).map((claim) => claim.id);
  assert.deepEqual(conversation.slice(-2), ["reask", "context"]);
  assert.ok(!owner.includes("reask"));
});

const claims = claimsFor(withRole("owner"));
const verdict = (id: string, value: "yes" | "no" = "yes") => ({
  id,
  reason: `because\n  of ${id}`,
  verdict: value,
});

test("parseVerdicts returns claim order and one-line reasons", () => {
  const raw = { verdicts: claims.map((c) => verdict(c.id)).reverse() };
  const parsed = parseVerdicts(claims, raw);
  assert.deepEqual(
    parsed.map((v) => v.id),
    claims.map((c) => c.id)
  );
  assert.equal(parsed[0]?.reason, "because of cause");
});

test("parseVerdicts rejects missing, duplicate, unknown and non yes/no verdicts", () => {
  const all = claims.map((c) => verdict(c.id));
  assert.throws(() => parseVerdicts(claims, { verdicts: all.slice(1) }));
  assert.throws(() =>
    parseVerdicts(claims, { verdicts: [...all, verdict("cause")] })
  );
  assert.throws(() =>
    parseVerdicts(claims, { verdicts: [...all, verdict("other")] })
  );
  assert.throws(() =>
    parseVerdicts(claims, {
      verdicts: [{ id: "cause", reason: "", verdict: 7 }, ...all.slice(1)],
    })
  );
});

/** Every claim yes except the indexes in `no`, so a new shared claim needs no test edits. */
const record = (name: string, no: number[] = []): JudgeRecord => ({
  answer: "Reconnect the inbox.\nThen resume | the campaign.",
  case: name,
  judgedAt: "2026-10-04T00:00:00.000Z",
  model: "test/model",
  recorded,
  verdicts: claims.map((c, n) => ({
    ...verdict(c.id, no.includes(n) ? "no" : "yes"),
    claim: c.text,
    reason: "a | b",
  })),
});

test("the review page has one markable row per claim and round-trips marks into gold", () => {
  const records = [record("a", [1])];
  const review = renderReview(records);
  assert.match(review, CAUSE_ROW);
  assert.equal(parseMarks(review).size, 0);
  const marked = review
    .replace(CAUSE_MARK, "$1 right |")
    .replace(ACTIONS_MARK, "$1 Wrong |");
  const marks = parseMarks(marked);
  assert.deepEqual(
    [...marks],
    [
      ["a#cause", true],
      ["a#actions", false],
    ]
  );
  const gold = toGold(records, marks);
  assert.deepEqual(gold[0]?.labels, [
    { claim: claims[0]?.text, expected: "yes", id: "cause" },
    { claim: claims[1]?.text, expected: "yes", id: "actions" },
  ]);
  assert.equal(gold[0]?.sample.answer, records[0].answer);
  assert.throws(() => parseMarks(review.replace(CAUSE_MARK, "$1 maybe |")));
});

test("saveRecord writes the record and regenerates the review", () => {
  const dir = mkdtempSync(`${tmpdir()}/judge-`);
  saveRecord(dir, record("b"));
  saveRecord(dir, record("a"));
  assert.deepEqual(
    readRecords(dir).map((r) => r.case),
    ["a", "b"]
  );
  const review = readFileSync(`${dir}/review.md`, "utf8");
  assert.ok(review.indexOf("## a") < review.indexOf("## b"));
});

const labelled = (sample: JudgeRecord): GoldEntry =>
  present(
    toGold(
      [sample],
      new Map(sample.verdicts.map((v) => [`${sample.case}#${v.id}`, true]))
    )[0]
  );
const run = (...samples: JudgeRecord[]) =>
  new Map(samples.map((sample) => [sample.case, sample]));
const allYes = (name: string) => record(name);

test("mergeGold replaces a relabelled sample and keeps the rest", () => {
  const old = [labelled(allYes("a")), labelled(allYes("b"))];
  const next = labelled(record("a", [0]));
  assert.deepEqual(mergeGold(old, [next]), [old[1], next]);
  const unmarked = toGold([allYes("a"), allYes("c")], new Map());
  assert.deepEqual(mergeGold(old, unmarked), [...old, unmarked[1]]);
});

test("marks on unknown or repeated rows are refused", () => {
  const records = [allYes("a")];
  assert.throws(() => toGold(records, new Map([["a#typo", true]])));
  const review = renderReview(records).replace(CAUSE_MARK, "$1 right |");
  const row = review.split("\n").find((line) => line.startsWith("| a#cause"));
  assert.throws(() => parseMarks(`${review}\n${row}`));
});

test("complete gold scoring counts agreement and flips per shared claim", () => {
  const a = allYes("a");
  const b = record("a", [1]);
  const scores = scoreAgainstGold([labelled(a)], run(a), run(b));
  const cause = present(scores.get("cause"));
  assert.deepEqual(cause.agreement, { agree: 2, total: 2 });
  assert.deepEqual(cause.flips, { flipped: 0, total: 1 });
  assert.ok(calibrated(cause));
  const actions = present(scores.get("actions"));
  assert.deepEqual(actions.agreement, { agree: 1, total: 2 });
  assert.deepEqual(actions.flips, { flipped: 1, total: 1 });
  assert.equal(calibrated(actions), false);
});

test("fully stale labels fail calibration with zero measured coverage", () => {
  const current = allYes("a");
  const old = {
    ...current,
    verdicts: current.verdicts.map((v) => ({ ...v, claim: `Old: ${v.claim}` })),
  };
  const scores = scoreAgainstGold([labelled(old)], run(current), run(current));
  for (const score of scores.values()) {
    assert.deepEqual(score.coverage, {
      measured: 0,
      missing: 0,
      required: 1,
      stale: 1,
      unlabelled: 0,
    });
    assert.equal(score.agreement.total, 0);
    assert.equal(calibrated(score), false);
  }
});

test("partly stale labels cannot hide behind measured perfect agreement", () => {
  const a = allYes("a");
  const b = allYes("b");
  const old = {
    ...b,
    verdicts: b.verdicts.map((v) =>
      v.id === "cause" ? { ...v, claim: "Old cause" } : v
    ),
  };
  const scores = scoreAgainstGold(
    [labelled(a), labelled(old)],
    run(a, b),
    run(a, b)
  );
  const cause = present(scores.get("cause"));
  assert.deepEqual(cause.agreement, { agree: 2, total: 2 });
  assert.deepEqual(cause.coverage, {
    measured: 1,
    missing: 0,
    required: 2,
    stale: 1,
    unlabelled: 0,
  });
  assert.equal(calibrated(cause), false);
  assert.ok(calibrated(present(scores.get("actions"))));
});

test("missing verdicts, removed claims, and unlabelled required claims fail calibration", () => {
  const a = allYes("a");
  const missing = {
    ...a,
    verdicts: a.verdicts.filter((v) => v.id !== "cause"),
  };
  const score = present(
    scoreAgainstGold([labelled(a)], run(missing), run(a)).get("cause")
  );
  assert.equal(score.coverage.missing, 1);
  assert.equal(calibrated(score), false);
  const partial = {
    ...labelled(a),
    labels: labelled(a).labels.filter((v) => v.id !== "facts"),
  };
  const unlabelled = present(
    scoreAgainstGold([partial], run(a), run(a)).get("facts")
  );
  assert.equal(unlabelled.coverage.unlabelled, 1);
  assert.equal(calibrated(unlabelled), false);
  const removed = {
    ...labelled(a),
    labels: [
      ...labelled(a).labels,
      { claim: "gone", expected: "yes" as const, id: "removed" },
    ],
  };
  assert.equal(
    scoreAgainstGold([removed], run(a), run(a)).get("removed")?.coverage.stale,
    1
  );
});

test("entirely unmarked cases remain in gold and fail coverage", () => {
  const a = allYes("a");
  const b = allYes("b");
  const gold = toGold(
    [a, b],
    new Map(a.verdicts.map((v) => [`a#${v.id}`, true]))
  );
  assert.equal(gold.length, 2);
  assert.deepEqual(gold[1]?.labels, []);
  const scores = scoreAgainstGold(gold, run(a, b), run(a, b));
  for (const score of scores.values()) {
    assert.equal(score.coverage.unlabelled, 1);
    assert.equal(calibrated(score), false);
  }
});

test("case-specific claims have independent bars while shared claims aggregate", () => {
  const custom = (name: string, text: string, value: "yes" | "no") => {
    const example = withRole("owner", { claims: [text] });
    return reviewedSample(
      name,
      example,
      "An answer.",
      claimsFor(example).map((c) =>
        verdict(c.id, c.id === "case-1" ? value : "yes")
      )
    );
  };
  const a = custom("a", "Names paused campaign", "yes");
  const b = custom("b", "Cites help article", "yes");
  const wrong = custom("b", "Cites help article", "no");
  const scores = scoreAgainstGold(
    [labelled(a), labelled(b)],
    run(a, wrong),
    run(a, wrong)
  );
  assert.ok(calibrated(present(scores.get("a#case-1"))));
  assert.equal(calibrated(present(scores.get("b#case-1"))), false);
  assert.equal(scores.get("cause")?.coverage.measured, 2);
  assert.equal(scores.has("case-1"), false);
});

test("unset cause allows justified clarification and uncertainty, not an expected absent cause", () => {
  const text = claimsFor(withRole("owner", { cause: null }))[0]?.text ?? "";
  assert.ok(text.includes("justified clarifying question"));
  assert.ok(text.includes("explicit uncertainty"));
  assert.ok(text.includes("question and tool results"));
  assert.ok(!text.includes("when they support none"));
});

test("review carries question, role, expectation, source and collapsible evidence with exact answer lines", () => {
  const sample = {
    ...allYes("a"),
    answer: "Step one.\nStep two with ``` literal fence.",
  };
  const review = renderReview([sample]);
  for (const text of [
    recorded.question,
    "Role: owner",
    "Authored cause: unset",
    "<details>",
    "widget_outreach_health",
    recorded.source.runId ?? `"runId": null`,
    sample.answer,
  ]) {
    assert.ok(review.includes(text), text);
  }
  assert.ok(review.includes("````text"));
  assert.deepEqual(judgeRecordSchema.parse(sample), sample);
  assert.throws(() =>
    judgeRecordSchema.parse({ ...sample, recorded: undefined })
  );
  assert.throws(() =>
    goldSchema.parse([
      {
        ...labelled(sample),
        labels: [{ claim: "x", expected: "yes", id: "unknown" }],
      },
    ])
  );
});

test("gold export refuses a private answer before writing any file or replacing existing gold", () => {
  const dir = mkdtempSync(`${tmpdir()}/judge-gold-`);
  const path = `${dir}/gold.json`;
  const safe = labelled(allYes("safe"));
  const unsafe = labelled({
    ...allYes("unsafe"),
    answer: "Contact secret-person@private-customer.example for details.",
  });
  assert.throws(() => writeGold(path, [safe, unsafe]), GOLD_REFUSAL);
  assert.equal(existsSync(path), false);
  writeFileSync(path, "previous gold");
  assert.throws(() => writeGold(path, [unsafe]), GOLD_REFUSAL);
  assert.equal(readFileSync(path, "utf8"), "previous gold");
  writeGold(path, [safe]);
  assert.deepEqual(goldSchema.parse(JSON.parse(readFileSync(path, "utf8"))), [
    safe,
  ]);
});

for (const cancellation of ["deadline", "caller"] as const) {
  test(`judgeAnswer cancels the mocked provider on ${cancellation}`, async (t) => {
    const deadline = new AbortController();
    const caller = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.equal(ms, JUDGE_TIMEOUT_MS);
      return deadline.signal;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          assert.ok(abortSignal);
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true }
          );
          started();
        }),
    });
    const pending = judgeAnswer(
      recorded,
      "An answer.",
      claims,
      cancellation === "caller" ? caller.signal : undefined,
      model
    );
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    await ready;
    (cancellation === "deadline" ? deadline : caller).abort(
      new DOMException("Cancelled", "AbortError")
    );
    await rejected;
    assert.equal(model.doGenerateCalls.length, 1);
  });
}
