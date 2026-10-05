import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import {
  claimsFor,
  type GoldEntry,
  type JudgeRecord,
  mergeGold,
  parseMarks,
  parseVerdicts,
  readRecords,
  renderReview,
  saveRecord,
  scoreAgainstGold,
  toGold,
  type Verdict,
} from "./widget-judge.js";

const CAUSE_TEXT = /two inboxes disconnected/;
const CAUSE_ROW = /\| a#cause \| .* \| yes \| a \\\| b \| {2}\|/;
const CAUSE_MARK = /(\| a#cause \|.*\|) {2}\|/;
const ACTIONS_MARK = /(\| a#actions \|.*\|) {2}\|/;

const recorded = widgetCaseSchema.parse(
  JSON.parse(readFileSync("evals/widget/cases/local-widget-smoke.json", "utf8"))
);
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
  assert.deepEqual(owner, ["cause", "actions", "facts", "steps", "jargon"]);
  assert.ok(claimsFor(withRole("member")).some((c) => c.id === "member"));
  assert.ok(claimsFor(withRole("client")).some((c) => c.id === "member"));
  assert.ok(!claimsFor(withRole("admin")).some((c) => c.id === "member"));
  const own = claimsFor(
    withRole("owner", { cause: "two inboxes disconnected", claims: ["X"] })
  );
  assert.match(own[0]?.text ?? "", CAUSE_TEXT);
  assert.deepEqual(own.at(-1), { id: "case-1", text: "X" });
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

const record = (name: string, values: ("yes" | "no")[]): JudgeRecord => ({
  answer: "Reconnect the inbox.\nThen resume | the campaign.",
  case: name,
  judgedAt: "2026-10-04T00:00:00.000Z",
  model: "test/model",
  verdicts: claims.map((c, n) => ({
    ...verdict(c.id, values[n]),
    claim: c.text,
    reason: "a | b",
  })),
});

test("the review page has one markable row per claim and round-trips marks into gold", () => {
  const records = [record("a", ["yes", "no", "yes", "yes", "yes"])];
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
  assert.deepEqual(gold[0]?.claims, [
    { claim: claims[0]?.text, expected: "yes", id: "cause" },
    { claim: claims[1]?.text, expected: "yes", id: "actions" },
  ]);
  assert.equal(gold[0]?.answer, records[0].answer);
  assert.throws(() => parseMarks(review.replace(CAUSE_MARK, "$1 maybe |")));
});

test("saveRecord writes the record and regenerates the review", () => {
  const dir = mkdtempSync(`${tmpdir()}/judge-`);
  saveRecord(dir, record("b", ["yes", "yes", "yes", "yes", "yes"]));
  saveRecord(dir, record("a", ["yes", "yes", "yes", "yes", "yes"]));
  assert.deepEqual(
    readRecords(dir).map((r) => r.case),
    ["a", "b"]
  );
  const review = readFileSync(`${dir}/review.md`, "utf8");
  assert.ok(review.indexOf("## a") < review.indexOf("## b"));
});

test("mergeGold replaces a relabelled case and keeps the rest", () => {
  const entry = (name: string, expected: "yes" | "no"): GoldEntry => ({
    answer: "x",
    case: name,
    claims: [{ claim: "c", expected, id: "cause" }],
  });
  assert.deepEqual(
    mergeGold([entry("a", "yes"), entry("b", "yes")], [entry("a", "no")]),
    [entry("b", "yes"), entry("a", "no")]
  );
});

test("gold scoring counts agreement per claim, flips between runs, and stale wording", () => {
  const gold: GoldEntry[] = [
    {
      answer: "x",
      case: "a",
      claims: [
        { claim: "C1", expected: "yes", id: "cause" },
        { claim: "S1", expected: "no", id: "steps" },
        { claim: "old wording", expected: "yes", id: "jargon" },
      ],
    },
  ];
  const run = (values: {
    cause: "yes" | "no";
    steps: "yes" | "no";
  }): Map<string, (Verdict & { claim: string })[]> =>
    new Map([
      [
        "a",
        [
          {
            claim: "C1",
            id: "cause",
            reason: "",
            verdict: values.cause,
          },
          {
            claim: "S1",
            id: "steps",
            reason: "",
            verdict: values.steps,
          },
          { claim: "J1", id: "jargon", reason: "", verdict: "yes" },
        ],
      ],
    ]);
  const scores = scoreAgainstGold(
    gold,
    run({ cause: "yes", steps: "no" }),
    run({ cause: "yes", steps: "yes" })
  );
  assert.deepEqual(scores.get("cause"), {
    agreement: { agree: 2, total: 2 },
    flips: { flipped: 0, total: 1 },
    stale: 0,
  });
  assert.deepEqual(scores.get("steps"), {
    agreement: { agree: 1, total: 2 },
    flips: { flipped: 1, total: 1 },
    stale: 0,
  });
  assert.deepEqual(scores.get("jargon"), {
    agreement: { agree: 0, total: 0 },
    flips: { flipped: 0, total: 0 },
    stale: 1,
  });
});
