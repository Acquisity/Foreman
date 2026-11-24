import assert from "node:assert/strict";
import { test } from "node:test";
import { readAgentDecision } from "./widget-campaign-agent-decisions.js";

const none = {
  checks: [],
  count: null,
  name: null,
  requiredPerVariant: null,
  variantCount: null,
};
// Shaped like the live 2026-11-24 review that paused a campaign.
const actions = [
  {
    details: none,
    index: 0,
    reason: "Zero positive replies",
    type: "PAUSE_CAMPAIGN",
  },
  {
    details: { ...none, count: 2500, name: "Fresh Angles" },
    index: 1,
    reason: null,
    type: "START_NEW_CAMPAIGN",
  },
  {
    details: { ...none, checks: ["spf", "dkim"] },
    index: 2,
    reason: null,
    type: "FLAG_DELIVERABILITY",
  },
];
const approval = {
  actionIndexes: [0, 1],
  autoExecutedAt: null,
  autoExecutesOnTimeout: false,
  expiresAt: "2026-11-25T07:36:48.151Z",
  requestedAt: "2026-11-24T07:36:48.151Z",
  respondedAt: "2026-11-24T14:07:24.296Z",
  status: "approved",
};
const approved = {
  actions,
  approval,
  at: "2026-11-24T07:35:17.102Z",
  completed: [
    { at: "2026-11-24T14:12:27.926Z", index: 1 },
    { at: "2026-11-24T14:13:00.274Z", index: 0 },
  ],
  error: null,
  finding: "Overall PRR is 0%. Replace this campaign with fresh angles.",
  recommended: ["Pause the current campaign with its replacement."],
  runStatus: "completed",
  skipped: [],
  verdict: "underperforming",
};

test("an approved review shows what ran, what didn't, and the labels the AI Agent tab shows", () => {
  const decision = readAgentDecision(approved);
  assert.deepEqual(
    decision.actions.map(({ at, label, state }) => [label, state, at]),
    [
      [
        "Pause campaign: Zero positive replies",
        "taken",
        "2026-11-24T14:13:00.274Z",
      ],
      [
        'Start "Fresh Angles" campaign (2,500 leads)',
        "taken",
        "2026-11-24T14:12:27.926Z",
      ],
      ["Flag deliverability: spf, dkim", "not_run", null],
    ]
  );
  assert.deepEqual(decision.approval, {
    autoExecutedAt: null,
    autoExecutesOnTimeout: false,
    expiresAt: "2026-11-25T07:36:48.151Z",
    requestedAt: "2026-11-24T07:36:48.151Z",
    respondedAt: "2026-11-24T14:07:24.296Z",
    status: "approved",
  });
});

test("an open approval waits on the actions it covers and runs the rest", () => {
  const decision = readAgentDecision({
    ...approved,
    approval: { ...approval, respondedAt: null, status: "awaiting_approval" },
    completed: [],
    runStatus: "awaiting_approval",
  });
  assert.deepEqual(
    decision.actions.map((action) => action.state),
    ["waiting_for_approval", "waiting_for_approval", "running"]
  );
});

test("an approval that ran on timeout says so, with nobody's answer", () => {
  const decision = readAgentDecision({
    ...approved,
    approval: {
      ...approval,
      autoExecutedAt: "2026-11-25T07:36:50.000Z",
      autoExecutesOnTimeout: true,
      respondedAt: null,
    },
  });
  assert.equal(decision.approval?.autoExecutedAt, "2026-11-25T07:36:50.000Z");
  assert.equal(decision.approval?.respondedAt, null);
});

test("a skipped action keeps the reason it was skipped", () => {
  const decision = readAgentDecision({
    ...approved,
    completed: [],
    skipped: [{ index: 1, reason: "No credits for new leads" }],
  });
  assert.deepEqual(decision.actions[1], {
    at: null,
    label: 'Start "Fresh Angles" campaign (2,500 leads)',
    reason: "No credits for new leads",
    state: "skipped",
    type: "START_NEW_CAMPAIGN",
  });
});
