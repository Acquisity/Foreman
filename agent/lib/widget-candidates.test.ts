import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CandidateRow,
  candidateRowSchema,
  conversationSignals,
  flagConversations,
  isPushback,
  nextPullState,
  parseExcludedOrgs,
  pendingCaseName,
  renderReview,
} from "./widget-candidates.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const TEST_ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
let counter = 0;
const HEADING = /## acme \//;
const QUESTION = /> How do I connect my Gmail inbox\?/;
const ANSWER = /> Reply\./;

const row = (overrides: Partial<CandidateRow> = {}): CandidateRow => {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const at = new Date(Date.UTC(2026, 9, 5, 12, counter));
  return {
    completed_at: at,
    conversation_id: CONVERSATION,
    created_at: at,
    decision: null,
    findings: null,
    id,
    organization_id: ORG,
    outcome: {
      decision: "allow",
      message: "Here is how to connect an inbox.",
      reason: "kb",
      status: "completed",
    },
    question: "How do I connect my Gmail inbox?",
    scope: { organizationSlug: "acme" },
    session_id: id,
    ...overrides,
  };
};
const withReason = (
  reason: string,
  decision: "allow" | "block" | "rewrite" = "allow"
) =>
  row({
    outcome: { decision, message: "Reply.", reason, status: "completed" },
  });
const kinds = (rows: CandidateRow[]) =>
  conversationSignals(rows).map((signal) => signal.kind);
const findings = (facts: number, needsHuman = false) => ({
  confidence: "medium",
  facts: Array.from({ length: facts }, () => ({
    claim: "The inbox is connected.",
    entityIds: [],
    evidence: { ref: "inbox", tool: "widget_inbox_health" },
  })),
  needsHuman,
  recommendation: "Which inbox do you mean?",
  report: "Asked which inbox.",
});
const all = () => true;
const none = new Set<string>();

test("a single help-center miss is kb_miss, a repeated one is repeated_kb_miss", () => {
  assert.deepEqual(kinds([withReason("kb_miss")]), ["kb_miss"]);
  assert.deepEqual(
    kinds([
      withReason("kb_miss"),
      row({ question: "Where are my campaign analytics shown?" }),
      withReason("kb_miss"),
    ]),
    ["repeated_kb_miss", "repeated_kb_miss"]
  );
});

test("asking for a human is its own signal, not also a handoff", () => {
  assert.deepEqual(kinds([withReason("asked_for_human", "block")]), [
    "asked_for_human",
  ]);
});

test("a block or a needs-human finding is a handoff", () => {
  assert.deepEqual(kinds([withReason("needs_human", "block")]), ["handoff"]);
  assert.deepEqual(
    kinds([row({ findings: findings(1, true), session_id: "wrun_A" })]),
    ["handoff"]
  );
});

test("a gate rewrite is flagged from the outcome or the stored decision", () => {
  assert.deepEqual(kinds([withReason("jev:remove_items:2", "rewrite")]), [
    "rewrite",
  ]);
  assert.deepEqual(kinds([row({ decision: "rewrite", outcome: null })]), [
    "rewrite",
  ]);
});

test("an investigation with no facts and no handoff only asked a clarifying question", () => {
  assert.deepEqual(
    kinds([row({ findings: findings(0), session_id: "wrun_A" })]),
    ["clarify_only"]
  );
  assert.deepEqual(
    kinds([row({ findings: findings(2), session_id: "wrun_A" })]),
    []
  );
  // A front-door reply with empty findings is not an investigation.
  assert.deepEqual(kinds([row({ findings: findings(0) })]), []);
});

test("pushback is a complaint or the same question asked again", () => {
  const asked = "How do I connect my Gmail inbox?";
  assert.ok(isPushback(asked, "That's wrong, I don't have that button"));
  assert.ok(isPushback(asked, "this is not helping"));
  assert.ok(isPushback(asked, "how do i connect my gmail inbox??"));
  assert.ok(!isPushback(asked, "Thanks, that worked!"));
  assert.ok(!isPushback(asked, "How do I pause a campaign?"));
  const first = row({ question: asked });
  const second = row({ question: "still not working" });
  assert.deepEqual(conversationSignals([first, second]), [
    { kind: "pushback", runIds: [first.id, second.id] },
  ]);
});

test("runs group into conversations, oldest first, one entry per flagged conversation", () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const answered = row({ question: "How do I add a domain?" });
  const pushed = row({ question: "that's not right" });
  const quiet = row({ conversation_id: other });
  const [candidate, ...rest] = flagConversations([pushed, quiet, answered], {
    excluded: none,
    isNew: all,
  });
  assert.equal(rest.length, 0);
  assert.equal(candidate.conversationId, CONVERSATION);
  assert.deepEqual(
    candidate.turns.map((turn) => turn.id),
    [answered.id, pushed.id]
  );
  assert.equal(candidate.workspace, "acme");
});

test("only investigation sessions behind a signal go to the converter", () => {
  const clarified = row({ findings: findings(0), session_id: "wrun_CLARIFY" });
  const answered = row({
    findings: findings(2),
    question: "Why did my campaign pause yesterday?",
    session_id: "wrun_FINE",
  });
  const [candidate] = flagConversations([clarified, answered], {
    excluded: none,
    isNew: all,
  });
  assert.deepEqual(candidate.investigationSessions, ["wrun_CLARIFY"]);
  assert.equal(pendingCaseName("wrun_01K0ABC"), "candidate-wrun-01k0abc");
});

test("excluded test workspaces never produce a candidate", () => {
  const excluded = parseExcludedOrgs(` ${TEST_ORG.toUpperCase()} ,`);
  assert.ok(excluded.has(TEST_ORG));
  const mine = withReason("kb_miss");
  const theirs = { ...withReason("kb_miss"), organization_id: TEST_ORG };
  assert.deepEqual(
    flagConversations([mine, theirs], { excluded, isNew: all }).map(
      (c) => c.organizationId
    ),
    [ORG]
  );
  assert.equal(parseExcludedOrgs(undefined).size, 2);
  assert.throws(() => parseExcludedOrgs("acme-test"));
});

test("an immediate rerun adds nothing, and new runs in an old conversation keep old context", () => {
  const missed = withReason("kb_miss");
  const first = nextPullState([missed], null);
  assert.deepEqual(first, {
    seen: [missed.id],
    through: missed.completed_at.toISOString(),
  });
  const since = first?.through ?? "";
  const seen = new Set(first?.seen);
  const isNew = (r: CandidateRow) =>
    r.completed_at.toISOString() >= since && !seen.has(r.id);
  assert.deepEqual(flagConversations([missed], { excluded: none, isNew }), []);
  assert.deepEqual(nextPullState([missed], first), first);
  assert.equal(nextPullState([], first), first);

  const pushed = row({ question: "this is useless" });
  const [candidate] = flagConversations([missed, pushed], {
    excluded: none,
    isNew,
  });
  // The earlier miss was already pulled; only the new pushback counts.
  assert.deepEqual(
    candidate.signals.map((signal) => signal.kind),
    ["pushback"]
  );
  assert.equal(candidate.turns.length, 2);
});

test("runs that share the newest millisecond are all remembered", () => {
  const a = row();
  const b = { ...row(), completed_at: a.completed_at };
  assert.deepEqual(nextPullState([a, b], null)?.seen, [a.id, b.id]);
});

test("rows parse from Postgres shapes and the review carries question, answer, signals and run ids", () => {
  const parsed = candidateRowSchema.parse({
    ...withReason("kb_miss"),
    completed_at: "2026-10-05 12:00:00.123456+00",
    created_at: "2026-10-05 11:59:58+00",
    outcome: { unexpected: true },
  });
  assert.equal(parsed.outcome, null);
  const missed = withReason("kb_miss");
  const review = renderReview(
    flagConversations([missed], { excluded: none, isNew: all }),
    "2026-10-05T20:00:00.000Z"
  );
  assert.match(review, HEADING);
  assert.match(review, QUESTION);
  assert.match(review, ANSWER);
  assert.match(review, new RegExp(`- kb_miss: ${missed.id}`));
});
