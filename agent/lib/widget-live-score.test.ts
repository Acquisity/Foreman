import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { type CandidateRow, parseExcludedOrgs } from "./widget-candidates.js";
import {
  claimsFor,
  judgeAnswer,
  renderScorecard,
  reviewedSample,
  SCORECARD_TARGETS,
  type ScoredReplay,
} from "./widget-judge.js";
import {
  type CauseLabels,
  carriedVerdicts,
  DRAFT_CAUSE_GOAL,
  LIVE_ANSWERED,
  LIVE_CAUSE_GOAL,
  labelLine,
  liveCase,
  liveClaims,
  liveScorecard,
  liveSetSchema,
  NEEDS_HUMAN,
  rankSet,
  rejudgedClaims,
  splitNeedsHuman,
  topicOf,
  twoColumnScorecard,
} from "./widget-live-score.js";
import { ELIGIBLE_INSTRUCTIONS } from "./widget-next-action.js";

const LIVE_CAUSE_ROW =
  /\| conclusion supported by the evidence read \| 50\.0% \| 4 \| {2}\| {2}\|/;
const REAL_CAUSE_ROW =
  /\| found the real cause \| 0\.0% \| 1 \| 90\.0% \| miss \|/;
const DRAFT_CAUSE_ROW =
  /\| found the real cause \(draft labels\) \| 100\.0% \| 1 \| {2}\| {2}\|/;
const ANSWERED_ROW =
  /\| answered what was needed \| 100\.0% \| 3 \| 90\.0% \| hit \|/;
const BUG_ROW = /\| answered what was needed \(bug\) \| 100\.0% \| 1 \|/;
const HANDOFF_ROW =
  /\| handed off only when needed \| 100\.0% \| 3 \| 90\.0% \| hit \|/;
const PRODUCTION_HANDOFF_ROW =
  /\| handed off only when needed \| 50\.0% of 2, miss \| 100\.0% of 2, hit \| 90\.0% \|/;
const PRODUCTION_LEAK_ROW =
  /\| no leaks \| 50\.0% of 2, miss \| 100\.0% of 2, hit \| 100\.0% \|/;
const PRODUCTION_TIME_ROW =
  /\| reply time, final reply \| n\/a \| p50 30\.0s, p90 30\.0s \|/;
const ORG = "06c49b56-44bc-4b46-8b6d-87e089c7b694";
const TEST_ORG = "5a30d304-32ab-4ee0-b7ea-c5605aa34ce5";
let serial = 0;
const row = (overrides: Partial<CandidateRow> & { reply?: string }) => {
  serial += 1;
  const { reply = "Your campaign is sending.", ...rest } = overrides;
  return {
    completed_at: new Date(Date.UTC(2026, 9, 9, 0, serial)),
    conversation_id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    created_at: new Date(Date.UTC(2026, 9, 9, 0, serial)),
    decision: "allow",
    findings: null,
    id: `10000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    organization_id: ORG,
    outcome: {
      decision: "allow",
      message: reply,
      reason: "investigated",
      status: "completed",
    },
    question: "Why is my campaign not sending?",
    scope: {},
    session_id: `wrun_01M4KAGQ198QGYNQBE5ZT969${String(serial).padStart(2, "0")}`,
    ...rest,
  } as CandidateRow;
};

test("set selection keeps one customer investigation per conversation, spread across topics, admitting runs first", () => {
  const conversation = "00000000-0000-4000-8000-999999999999";
  const plain = row({ conversation_id: conversation });
  const admits = row({
    conversation_id: conversation,
    created_at: new Date(Date.UTC(2026, 9, 8)),
    reply: "I could not confirm when the delay changed.",
  });
  const billing = row({ question: "Why was I charged twice?" });
  const billingAsks = row({
    question: "Refund please",
    reply: "Which charge do you mean?",
  });
  const excluded = [
    row({ organization_id: TEST_ORG }),
    row({ scope: { source: "inbox" } as CandidateRow["scope"] }),
    row({ session_id: "10000000-0000-4000-8000-000000000999" }),
    row({ outcome: null }),
  ];
  const ranked = rankSet([plain, admits, billing, billingAsks, ...excluded]);
  assert.deepEqual(
    ranked.map(({ row: picked, topic }) => [picked.id, topic]),
    [
      [billingAsks.id, "billing"],
      [admits.id, "campaigns"],
      [billing.id, "billing"],
    ]
  );
  assert.equal(topicOf("My website will not publish"), "website");
  assert.equal(topicOf("hello"), "other");
});

test("the live picker leaves out Aaron's workspace and the Trivox AI demo workspace by default", () => {
  const internal = [
    "af11d514-3fbd-459c-8425-81b6b80929a0",
    "5a30d304-32ab-4ee0-b7ea-c5605aa34ce5",
  ];
  const kept = row({});
  const ranked = rankSet([
    kept,
    ...internal.map((id) => row({ organization_id: id })),
  ]);
  assert.deepEqual(
    ranked.map(({ row: picked }) => picked.id),
    [kept.id]
  );
  for (const id of internal) {
    assert.ok(parseExcludedOrgs(undefined).has(id));
  }
});

test("a set snapshot round-trips through its file with the verified scope intact", () => {
  const set = {
    cases: [
      {
        cassette: [
          {
            input: { campaignId: null },
            output: { campaigns: [] },
            requestedAt: "2026-10-07T22:01:28.314Z",
            resultAt: "2026-10-07T22:01:29.314Z",
            status: "completed",
            tool: "widget_outreach_health",
          },
        ],
        question: "Why did my follow-ups go out early?",
        reply: "I could not confirm why.",
        runId: "wrun_41M4C65K460GV34YR42A4W6NAN",
        scope: { ...fixture, recordingId: "rec_1" },
        sentAt: "2026-10-07T22:01:28.314Z",
        topic: "campaigns",
      },
    ],
    pickedAt: "2026-10-10T00:00:00.000Z",
  };
  const parsed = liveSetSchema.parse(set);
  assert.deepEqual(
    liveSetSchema.parse(JSON.parse(JSON.stringify(parsed))),
    parsed
  );
  assert.equal(parsed.cases[0]?.scope.recordingId, "rec_1");
  assert.throws(() => liveSetSchema.parse({ ...set, cases: [] }));
});

const RUN = "wrun_41M4C65K460GV34YR42A4W6NAN";
const live = (needsHuman?: boolean, runId = RUN, labels: CauseLabels = {}) =>
  liveCase(
    {
      cassette: [],
      question: "Why did my follow-ups go out early?",
      runId,
      scope: { role: "owner", workspace: "workspace-1" },
    },
    needsHuman,
    labels[runId]
  );

const REFUND_NOT_A_HANDOFF = /refund request on its own.*not this/;
const OLD_TEAM_FIX = /needs the Acquisity team/;

test("the live handoff criterion is the product's own handoff rule", () => {
  // Aaron, 2026-10-10: a person only on an explicit ask or a concrete billing dispute.
  assert.ok(NEEDS_HUMAN.text.includes(ELIGIBLE_INSTRUCTIONS));
  assert.match(NEEDS_HUMAN.text, REFUND_NOT_A_HANDOFF);
  assert.doesNotMatch(NEEDS_HUMAN.text, OLD_TEAM_FIX);
});

test("live judging needs no authored expectation and decides the handoff from the evidence", async () => {
  const claims = [...claimsFor(live()), NEEDS_HUMAN];
  assert.deepEqual(
    claims.map(({ id }) => id),
    [
      "cause",
      "actions",
      "facts",
      "steps",
      "jargon",
      "caveats",
      "invented",
      "case-1",
      "needs_human",
    ]
  );
  assert.equal(claims.find(({ id }) => id === "case-1")?.text, LIVE_ANSWERED);
  const judged = await judgeAnswer(
    live(),
    "Your follow-ups use a 3-day delay.",
    claims,
    undefined,
    async () => ({
      gaps: [],
      verdicts: claims.map(({ id }) => ({
        id,
        reason: "ok",
        verdict: id === "needs_human" ? "yes" : "no",
      })),
    })
  );
  const split = splitNeedsHuman(judged.verdicts);
  assert.equal(split.needsHuman, true);
  assert.ok(!split.verdicts.some(({ id }) => id === "needs_human"));
  // The remaining verdicts are exactly the replay claims, so the replay record accepts them.
  reviewedSample(
    "wrun_41M4C65K460GV34YR42A4W6NAN",
    live(),
    "answer",
    split.verdicts,
    []
  );
  assert.equal(live(true).expectations.lane, "human");
  assert.equal(live().expectations.lane, null);
});

test("the live scorecard grades the real cause on confirmed labels only and drops excluded cases", () => {
  const [confirmed, draft, excluded, unlabeled] = [
    RUN,
    "wrun_41M4C65K460GV34YR42A4W6NAA",
    "wrun_41M4C65K460GV34YR42A4W6NAB",
    "wrun_41M4C65K460GV34YR42A4W6NAC",
  ] as const;
  const label = { cause: "the sending rules", source: "Aaron" };
  const labels: CauseLabels = {
    [confirmed]: { ...label, causeType: "user_error", status: "confirmed" },
    [draft]: { ...label, causeType: "bug", status: "draft" },
    [excluded]: {
      ...label,
      causeType: "unclear",
      exclude: true,
      status: "confirmed",
    },
  };
  const recorded = live(false, confirmed, labels);
  assert.equal(recorded.expectations.cause, "the sending rules");
  assert.equal(recorded.expectations.causeType, "user_error");
  // A labeled case is judged on the labeled cause and, separately, on the evidence read.
  assert.deepEqual(
    liveClaims(recorded).map(({ id }) => id),
    [
      "cause",
      "actions",
      "facts",
      "steps",
      "jargon",
      "caveats",
      "invented",
      "fix",
      "case-1",
      "supported",
    ]
  );
  assert.equal(live(false, excluded, labels).expectations.cause, null);
  const replay = (runId: string, wrongCause: boolean): ScoredReplay => {
    const graded = live(false, runId, labels);
    const claims = liveClaims(graded);
    return {
      caseName: runId,
      record: reviewedSample(
        runId,
        graded,
        "answer",
        claims.map(({ id }) => ({
          id,
          reason: "ok",
          verdict: wrongCause && id === "cause" ? "no" : "yes",
        })),
        [],
        claims
      ),
      recorded: graded,
      row: {
        answer: "answer",
        budgetHit: false,
        handedOff: false,
        leaks: "pass",
        rawFields: "pass",
        scored: true,
      },
    };
  };
  const card = liveScorecard(
    [
      replay(confirmed, true),
      replay(draft, false),
      replay(excluded, true),
      replay(unlabeled, true),
    ],
    labels
  );
  assert.deepEqual(card.labels, {
    confirmed: 1,
    draft: 1,
    excluded: 1,
    unlabeled: 1,
  });
  assert.equal(
    labelLine(card),
    "Cause labels: 1 confirmed, 1 draft, 1 excluded, 1 unlabeled (no cause verdict)."
  );
  assert.deepEqual(
    card.rates.map(({ goal }) => goal),
    [
      "found the real cause",
      DRAFT_CAUSE_GOAL,
      LIVE_CAUSE_GOAL,
      "nothing made up",
      "answered what was needed",
      "answered what was needed (user_error)",
      "answered what was needed (platform_limitation)",
      "answered what was needed (bug)",
      "answered what was needed (unclear)",
      "handed off only when needed",
      "no leaks",
      "stayed in budget",
      "no tool gaps",
    ]
  );
  const conclusion = card.rates.find(({ goal }) => goal === LIVE_CAUSE_GOAL);
  assert.deepEqual(conclusion, { goal: LIVE_CAUSE_GOAL, pass: 2, total: 4 });
  const text = renderScorecard(card, SCORECARD_TARGETS);
  assert.match(text, LIVE_CAUSE_ROW);
  assert.match(text, REAL_CAUSE_ROW);
  assert.match(text, DRAFT_CAUSE_ROW);
  assert.match(text, BUG_ROW);
  const handoffs = renderScorecard(
    liveScorecard(
      [
        replay(confirmed, false),
        replay(draft, false),
        replay(unlabeled, false),
      ],
      labels
    ),
    SCORECARD_TARGETS
  );
  assert.match(handoffs, HANDOFF_ROW);
  assert.match(handoffs, ANSWERED_ROW);
});

test("a rejudge asks only the labeled cause and claims the record lacks, carrying the old conclusion", () => {
  const unlabeled = live();
  const old = reviewedSample(
    RUN,
    unlabeled,
    "answer",
    claimsFor(unlabeled).map(({ id }) => ({
      id,
      reason: id,
      verdict: "yes" as const,
    })),
    []
  );
  const forced = new Set(["cause"]);
  // Unlabeled, forcing the cause asks nothing: that verdict is the conclusion.
  assert.deepEqual(
    rejudgedClaims(
      liveClaims(unlabeled),
      carriedVerdicts(old, unlabeled),
      forced,
      unlabeled
    ),
    []
  );
  const labeled = live(false, RUN, {
    [RUN]: {
      cause: "the sending rules",
      causeType: "platform_limitation",
      source: "Aaron",
      status: "confirmed",
    },
  });
  const carried = carriedVerdicts(old, labeled);
  assert.equal(carried.get("supported")?.reason, "cause");
  assert.equal(carried.has("cause"), false);
  assert.deepEqual(
    rejudgedClaims(liveClaims(labeled), carried, forced, labeled).map(
      ({ id }) => id
    ),
    ["cause", "fix"]
  );
});

test("the two-column scorecard puts production beside live at HEAD per goal", () => {
  const record = reviewedSample(
    "wrun_41M4C65K460GV34YR42A4W6NAN",
    live(),
    "answer",
    claimsFor(live()).map(({ id }) => ({
      id,
      reason: "ok",
      verdict: "yes" as const,
    })),
    []
  );
  const replay = (handed: boolean, leak: "fail" | "pass"): ScoredReplay => ({
    caseName: "wrun_41M4C65K460GV34YR42A4W6NAN",
    record,
    recorded: live(),
    row: {
      answer: "answer",
      budgetHit: false,
      finalReplyMs: 30_000,
      handedOff: handed,
      leaks: leak,
      rawFields: "pass",
      scored: true,
    },
  });
  const production = liveScorecard(
    [replay(true, "fail"), replay(false, "pass")],
    {}
  );
  const head = liveScorecard(
    [replay(false, "pass"), replay(false, "pass")],
    {}
  );
  const text = twoColumnScorecard(
    {
      ...production,
      replies: production.replies.map((reply) => ({
        ...reply,
        p50: null,
        p90: null,
        samples: 0,
      })),
    },
    head
  );
  assert.match(text, PRODUCTION_HANDOFF_ROW);
  assert.match(text, PRODUCTION_LEAK_ROW);
  assert.match(text, PRODUCTION_TIME_ROW);
});
