import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import type { CandidateRow } from "./widget-candidates.js";
import {
  claimsFor,
  judgeAnswer,
  renderScorecard,
  reviewedSample,
  type ScoredReplay,
  scorecard,
} from "./widget-judge.js";
import {
  LIVE_ANSWERED,
  LIVE_CAUSE_GOAL,
  LIVE_TARGETS,
  liveCase,
  liveScorecard,
  liveSetSchema,
  NEEDS_HUMAN,
  rankSet,
  splitNeedsHuman,
  topicOf,
} from "./widget-live-score.js";

const LIVE_CAUSE_ROW =
  /\| conclusion supported by the evidence read \| 100\.0% \| 2 \| 90\.0% \| hit \|/;
const HANDOFF_ROW =
  /\| handed off only when needed \| 100\.0% \| 2 \| 90\.0% \| hit \|/;
const REPLAY_CAUSE_ROW = /found the real cause/;
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

const live = (needsHuman?: boolean) =>
  liveCase(
    {
      cassette: [],
      question: "Why did my follow-ups go out early?",
      runId: "wrun_41M4C65K460GV34YR42A4W6NAN",
      scope: { role: "owner", workspace: "workspace-1" },
    },
    needsHuman
  );

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

test("the live scorecard relabels the cause goal, keeps targets and drops per-cause-type rows", () => {
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
  const replay = (needsHuman: boolean, handed: boolean): ScoredReplay => ({
    caseName: "wrun_41M4C65K460GV34YR42A4W6NAN",
    record,
    recorded: live(needsHuman),
    row: {
      answer: "answer",
      budgetHit: false,
      handedOff: handed,
      leaks: "pass",
      rawFields: "pass",
      scored: true,
    },
  });
  const card = liveScorecard(
    scorecard([replay(true, true), replay(false, false)])
  );
  assert.deepEqual(
    card.rates.map(({ goal }) => goal),
    [
      LIVE_CAUSE_GOAL,
      "nothing made up",
      "answered what was needed",
      "handed off only when needed",
      "no leaks",
      "stayed in budget",
      "no tool gaps",
    ]
  );
  const text = renderScorecard(card, LIVE_TARGETS);
  assert.match(text, LIVE_CAUSE_ROW);
  assert.match(text, HANDOFF_ROW);
  assert.doesNotMatch(text, REPLAY_CAUSE_ROW);
});
