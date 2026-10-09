import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { tool as sdrTool } from "../tools/widget_sdr_thread_status.js";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import {
  citedArticles,
  claimsFor,
  JUDGE_TIMEOUT_MS,
  type JudgeRecord,
  judgeAnswer,
  judgeInput,
  judgeRecordSchema,
  parseGaps,
  parseMarks,
  parseVerdicts,
  readRecords,
  renderReview,
  renderScorecard,
  reviewedSample,
  SCORECARD_TARGETS,
  saveRecord,
  scorecard,
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

const LEAK_RATE_ROW = /\| no leaks \| 66\.7% \| 3 \| {2}\| {2}\|/;
const TOP_GAP_ROW = /2 {2}sequence content/;
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

test("a cited run's judge input carries the cited article text and the widget affordances", async () => {
  const urls: string[] = [];
  const articles = await citedArticles(
    [
      "https://help.acquisity.ai/docs/mailboxes",
      "https://help.acquisity.ai/docs/mailboxes",
      "https://example.com/docs/elsewhere",
    ],
    {
      baseUrl: "https://help.acquisity.ai",
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              content: `Click Add New Inboxes.${"x".repeat(41_000)}`,
              title: "Add mailboxes",
              url,
            }),
          ok: true,
          status: 200,
        });
      },
    }
  );
  assert.equal(
    urls.length,
    1,
    "each cited article is read once, off-site urls never"
  );
  const input = JSON.parse(
    judgeInput(recorded, "An answer.", claims, articles)
  );
  assert.equal(input.citedArticles.length, 1);
  assert.equal(input.citedArticles[0].title, "Add mailboxes");
  assert.ok(
    input.citedArticles[0].content.startsWith("Click Add New Inboxes.")
  );
  assert.equal(input.citedArticles[0].content.length, 40_000);
  assert.ok(
    input.widgetAffordances.some((line: string) =>
      line.includes("magnifying glass")
    )
  );
  assert.ok(
    input.widgetAffordances.some((line: string) =>
      line.includes("AI Consultant")
    )
  );
  assert.ok(
    input.widgetAffordances.some((line: string) =>
      line.includes("Report a problem")
    )
  );
});

test("WIDGET_JUDGE_DOCS reads cited articles from a local docs folder instead of the help center", async () => {
  const docs = mkdtempSync(`${tmpdir()}/judge-docs-`);
  mkdirSync(`${docs}/crm`);
  writeFileSync(
    `${docs}/crm/index.mdx`,
    '---\ntitle: "CRM"\n---\nimport X from "x";\nOpen "CRM" in the left sidebar.\n'
  );
  process.env.WIDGET_JUDGE_DOCS = docs;
  try {
    const articles = await citedArticles([
      "https://app.acquisity.ai/docs/crm",
      "https://app.acquisity.ai/docs/missing",
    ]);
    assert.deepEqual(articles, [
      {
        content: 'Open "CRM" in the left sidebar.',
        title: "CRM",
        url: "/docs/crm",
      },
    ]);
  } finally {
    delete process.env.WIDGET_JUDGE_DOCS;
  }
});

test("WIDGET_JUDGE_NAV adds the app's navigation as one more source, cited or not", async () => {
  const dir = mkdtempSync(`${tmpdir()}/judge-nav-`);
  writeFileSync(
    `${dir}/nav.txt`,
    'Under the "Outreach" heading: "Cold Email Agent"'
  );
  process.env.WIDGET_JUDGE_DOCS = dir;
  process.env.WIDGET_JUDGE_NAV = `${dir}/nav.txt`;
  try {
    assert.deepEqual(await citedArticles([]), [
      {
        content: 'Under the "Outreach" heading: "Cold Email Agent"',
        title: "App navigation (sidebar and menus)",
        url: "/docs",
      },
    ]);
  } finally {
    delete process.env.WIDGET_JUDGE_DOCS;
    delete process.env.WIDGET_JUDGE_NAV;
  }
});

test("a user error or limitation case also needs the fix claim; a bug does not", () => {
  const ids = (causeType: WidgetCase["expectations"]["causeType"]) =>
    claimsFor(withRole("owner", { causeType })).map((claim) => claim.id);
  assert.ok(ids("user_error").includes("fix"));
  assert.ok(ids("platform_limitation").includes("fix"));
  assert.ok(!ids("bug").includes("fix"));
  assert.ok(!ids(undefined).includes("fix"));
});

test("parseGaps keeps a capability only on a tool gap and bounds each sentence", () => {
  assert.deepEqual(
    parseGaps({
      gaps: [
        {
          capability: " sequence content ",
          kind: "tool_gap",
          sentence: "I could\n not see it.",
        },
        { capability: "x", kind: "tool_failure", sentence: "The read failed." },
        { capability: null, kind: "tool_gap", sentence: "Not available." },
      ],
      verdicts: [],
    }),
    [
      {
        capability: "sequence content",
        kind: "tool_gap",
        sentence: "I could not see it.",
      },
      { capability: null, kind: "tool_failure", sentence: "The read failed." },
      { capability: "unnamed", kind: "tool_gap", sentence: "Not available." },
    ]
  );
  assert.throws(() =>
    parseGaps({ gaps: [{ capability: null, kind: "other", sentence: "" }] })
  );
});

test("scorecard reports pass rates per goal and ranks tool gaps", () => {
  const userError = withRole("owner", {
    causeType: "user_error",
    claims: ["Says where to fix it."],
  });
  const all = (list: ReturnType<typeof claimsFor>, no: string[] = []) =>
    list.map((claim) =>
      verdict(claim.id, no.includes(claim.id) ? "no" : "yes")
    );
  const good = reviewedSample(
    "a",
    userError,
    "Answer.",
    all(claimsFor(userError)),
    [{ capability: "Sequence content", kind: "tool_gap", sentence: "s" }]
  );
  const bad = reviewedSample(
    "b",
    userError,
    "Answer.",
    all(claimsFor(userError), ["fix", "invented"]),
    [
      { capability: "sequence content", kind: "tool_gap", sentence: "s" },
      { capability: "billing history", kind: "tool_gap", sentence: "t" },
      { capability: null, kind: "real_unknown", sentence: "u" },
    ]
  );
  const row = {
    budgetHit: false,
    finalReplyMs: 20_000,
    firstReplyMs: 1000,
    handedOff: false,
    leaks: "pass",
    rawFields: "pass",
  };
  const card = scorecard([
    { record: good, recorded: userError, row },
    {
      record: bad,
      recorded: userError,
      row: { ...row, budgetHit: true, finalReplyMs: 40_000 },
    },
    {
      record: null,
      recorded: userError,
      row: { leaks: "fail", rawFields: "pass", scored: false },
    },
  ]);
  const rate = (goal: string) => card.rates.find((r) => r.goal === goal);
  assert.deepEqual(rate("found the real cause"), {
    goal: "found the real cause",
    pass: 2,
    total: 2,
  });
  assert.deepEqual(rate("nothing made up"), {
    goal: "nothing made up",
    pass: 1,
    total: 2,
  });
  assert.deepEqual(rate("answered what was needed (user_error)"), {
    goal: "answered what was needed (user_error)",
    pass: 1,
    total: 2,
  });
  assert.equal(rate("answered what was needed (bug)")?.total, 0);
  assert.deepEqual(rate("handed off only when needed"), {
    goal: "handed off only when needed",
    pass: 2,
    total: 2,
  });
  assert.deepEqual(rate("no leaks"), { goal: "no leaks", pass: 2, total: 3 });
  assert.deepEqual(rate("stayed in budget"), {
    goal: "stayed in budget",
    pass: 1,
    total: 2,
  });
  assert.deepEqual(rate("no tool gaps"), {
    goal: "no tool gaps",
    pass: 0,
    total: 2,
  });
  assert.deepEqual(card.gaps, [
    ["sequence content", 2],
    ["billing history", 1],
  ]);
  assert.deepEqual(card.replies[1], {
    key: "final reply",
    p50: 20,
    p90: 40,
    samples: 2,
  });
  const text = renderScorecard(card);
  assert.match(text, LEAK_RATE_ROW);
  assert.match(text, TOP_GAP_ROW);
});

const scoredSample = () => {
  const example = withRole("owner", {
    causeType: "user_error",
    claims: ["Answers the customer's request."],
  });
  return {
    record: reviewedSample(
      "scored",
      example,
      "Answer.",
      claimsFor(example).map((c) => verdict(c.id)),
      []
    ),
    recorded: example,
    row: {
      answer: "Answer.",
      finalReplyMs: 20_000,
      firstReplyMs: 1000,
      scored: true,
    },
  };
};

test("gap judging receives authoritative tool schemas and ranks unused capabilities separately", () => {
  const input = JSON.parse(judgeInput(recorded, "Answer.", claims));
  const sdr = input.widgetToolCapabilities.find(
    (tool: { name: string }) => tool.name === "widget_sdr_thread_status"
  );
  assert.equal(sdr.description, sdrTool.description);
  assert.ok(sdr.inputSchema.properties.threadId);
  const gaps = parseGaps({
    gaps: [
      {
        capability: " conferencing setup ",
        kind: "unused_capability",
        sentence: "I could not confirm the setup.",
      },
    ],
  });
  const sample = scoredSample();
  sample.record.gaps = gaps;
  const card = scorecard([sample]);
  assert.deepEqual(card.gaps, []);
  assert.deepEqual(card.unused, [["conferencing setup", 1]]);
  assert.equal(card.rates.find((r) => r.goal === "no tool gaps")?.pass, 1);
});

test("scorecard keeps unanswered and unjudged scored replays in denominators and marks missing coverage", () => {
  const sample = scoredSample();
  const card = scorecard([
    sample,
    { ...sample, record: null, row: { ...sample.row, answer: null } },
    { ...sample, record: null },
  ]);
  assert.equal(card.scored, 3);
  assert.equal(card.missingCoverage, 1);
  for (const goal of [
    "found the real cause",
    "nothing made up",
    "answered what was needed",
    "no tool gaps",
  ]) {
    const rate = card.rates.find((r) => r.goal === goal);
    assert.equal(rate?.total, 3);
    assert.equal(rate?.pass, 1);
  }
  assert.ok(renderScorecard(card).includes("1 missing judge coverage"));
  const previousTarget = SCORECARD_TARGETS["found the real cause"];
  SCORECARD_TARGETS["found the real cause"] = 1;
  try {
    const incomplete = renderScorecard(card);
    assert.ok(
      incomplete.includes("| found the real cause | 33.3% | 3 |  |  |")
    );
    const complete = renderScorecard(scorecard([sample]));
    assert.ok(
      complete.includes("| found the real cause | 100.0% | 1 | 100.0% | hit |")
    );
  } finally {
    SCORECARD_TARGETS["found the real cause"] = previousTarget;
  }
});

test("scorecard latency excludes unscored replays from nearest-rank percentiles", () => {
  const sample = scoredSample();
  const card = scorecard([
    sample,
    {
      ...sample,
      row: {
        ...sample.row,
        finalReplyMs: 900_000,
        firstReplyMs: 900_000,
        scored: false,
      },
    },
  ]);
  assert.deepEqual(card.replies, [
    { key: "first reply", p50: 1, p90: 1, samples: 1 },
    { key: "final reply", p50: 20, p90: 20, samples: 1 },
  ]);
});

test("answered score requires context and reask and treats absent required verdicts as missing coverage", () => {
  const base = scoredSample();
  const example = {
    ...base.recorded,
    question:
      "LATEST CUSTOMER MESSAGE (the one to work on):\nAnd my invoice?\n\nEARLIER TURNS (context):\nCustomer: My invoice is missing.",
  };
  const sample = {
    ...base,
    record: reviewedSample(
      "context",
      example,
      "Answer.",
      claimsFor(example).map((c) => verdict(c.id)),
      []
    ),
    recorded: example,
  };
  for (const id of ["context", "reask"]) {
    const failed = {
      ...sample,
      record: {
        ...sample.record,
        verdicts: sample.record.verdicts.map((v) =>
          v.id === id ? { ...v, verdict: "no" as const } : v
        ),
      },
    };
    assert.equal(
      scorecard([failed]).rates.find(
        (r) => r.goal === "answered what was needed"
      )?.pass,
      0
    );
    const missing = {
      ...sample,
      record: {
        ...sample.record,
        verdicts: sample.record.verdicts.filter((v) => v.id !== id),
      },
    };
    const card = scorecard([missing]);
    assert.equal(card.missingCoverage, 1);
    assert.equal(
      card.rates.find((r) => r.goal === "answered what was needed")?.pass,
      0
    );
    assert.equal(
      card.rates.find((r) => r.goal === "answered what was needed")?.total,
      1
    );
  }
});
