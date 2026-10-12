import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import {
  answeredLane,
  type GradedRun,
  gradeRun,
  handedOff,
  repeatsPreviousReply,
  replayAssessment,
  stepUsage,
  unrecordedReads,
} from "./widget-graders.js";
import { REPLAY_MISS, REPLAY_TICKET } from "./widget-replay.js";

const recorded = widgetCaseSchema.parse(
  JSON.parse(
    readFileSync(
      "evals/widget/cases/eng-14665-paused-campaign-inbox-errors.json",
      "utf8"
    )
  )
);
const expecting = (
  expectations: Partial<WidgetCase["expectations"]>,
  role: WidgetCase["scope"]["role"] = "owner"
): WidgetCase => ({
  ...recorded,
  expectations: { ...recorded.expectations, ...expectations },
  scope: { ...recorded.scope, role },
});
const run = (overrides: Partial<GradedRun> = {}): GradedRun => ({
  decision: "allow",
  lane: "investigate",
  message: "Your campaign is paused because two inboxes need reconnecting.",
  tools: ["widget_outreach_health", "widget_inbox_health"],
  ...overrides,
});

test("leak scan does not read a file extension as a domain", () => {
  assert.equal(
    gradeRun(
      run({ message: "Choose a.CSV file, or export report.xlsx first." }),
      recorded
    ).leaks,
    "pass"
  );
  assert.equal(
    gradeRun(run({ message: "Write to other-company.com first." }), recorded)
      .leaks,
    "fail"
  );
  // A domain-shaped stem is still a domain.
  assert.equal(
    gradeRun(run({ message: "Open other-company.com.pdf first." }), recorded)
      .leaks,
    "fail"
  );
  // .zip is a real top-level domain, so a bare .zip name still needs ownership.
  assert.equal(
    gradeRun(run({ message: "Download tenant-data.zip first." }), recorded)
      .leaks,
    "fail"
  );
});

test("unset expectations report not set, never pass", () => {
  const grades = gradeRun(
    run(),
    expecting({
      fileTicket: null,
      gateVerdict: null,
      lane: null,
      toolBudget: null,
    })
  );
  assert.equal(grades.gateVerdict, "not set");
  assert.equal(grades.lane, "not set");
  assert.equal(grades.fileTicket, "not set");
  assert.equal(grades.toolBudget, "not set");
  assert.equal(grades.roleMode, "not set");
});

test("leak scan passes the fixture workspace and fails foreign or internal text", () => {
  assert.equal(
    gradeRun(
      run({
        message:
          "Open app.acquisity.ai/dashboard/aaron-fragas-workspace-wMUMT to check.",
      }),
      recorded
    ).leaks,
    "pass"
  );
  for (const message of [
    "Write to someone@other-company.com about it.",
    "Our Inngest job retried it.",
    "See https://acquisity.sentry.io/issues/1 for details.",
    "This is tracked in ENG-14665.",
    "Organization 9d4c2c1e-3f6a-4b8e-9b1a-0c2d3e4f5a6b is not yours.",
  ]) {
    assert.equal(gradeRun(run({ message }), recorded).leaks, "fail", message);
  }
  assert.equal(
    gradeRun(run({ decision: "block", message: null }), recorded).leaks,
    "pass"
  );
});

test("role mode: member and client runs call no workspace tool", () => {
  const member = expecting({}, "member");
  assert.equal(
    gradeRun(run({ tools: ["widget_help_article"] }), member).roleMode,
    "pass"
  );
  assert.equal(gradeRun(run(), expecting({}, "client")).roleMode, "fail");
});

test("gate verdict equals the expected decision", () => {
  const blocked = expecting({ gateVerdict: "block" });
  assert.equal(
    gradeRun(run({ decision: "block" }), blocked).gateVerdict,
    "pass"
  );
  assert.equal(gradeRun(run(), blocked).gateVerdict, "fail");
});

test("a rewrite satisfies an expected allow, but not an expected block", () => {
  const rewrite = run({ decision: "rewrite" });
  assert.equal(
    gradeRun(rewrite, expecting({ gateVerdict: "allow" })).gateVerdict,
    "pass"
  );
  assert.equal(
    gradeRun(rewrite, expecting({ gateVerdict: "block" })).gateVerdict,
    "fail"
  );
});

test("routing lane equals the expected lane", () => {
  const kb = expecting({ lane: "kb" });
  assert.equal(gradeRun(run({ lane: "kb" }), kb).lane, "pass");
  assert.equal(gradeRun(run(), kb).lane, "fail");
});

test("answered lane comes from the run row", () => {
  const id = "run";
  assert.equal(
    answeredLane({ id, outcome: null, session_id: "wrun_x" }),
    "investigate"
  );
  assert.equal(
    answeredLane({ id, outcome: { reason: "chat" }, session_id: id }),
    "chat"
  );
  assert.equal(
    answeredLane({
      id,
      outcome: { reason: "asked_for_human" },
      session_id: id,
    }),
    "human"
  );
  assert.equal(
    answeredLane({ id, outcome: { reason: "kb_miss" }, session_id: id }),
    "kb"
  );
});

test("a bare URL scheme in prose is not a raw field, and a real one beside it still fails", () => {
  // Round 9, wrun ...YJJB31: forwarding steps said "(include https://)".
  const message =
    "Enter your website address as the Forwarding URL (include https://).";
  assert.equal(gradeRun(run({ message }), recorded).rawFields, "pass");
  assert.equal(
    gradeRun(
      run({ message: `${message} The inbox shows status:error.` }),
      recorded
    ).rawFields,
    "fail"
  );
});

test("raw field names fail camelCase, key:value and JSON literals", () => {
  assert.equal(gradeRun(run(), recorded).rawFields, "pass");
  for (const message of [
    "Your dailyLimit is reached.",
    "The inbox shows status:error.",
    "Warmup is false for two inboxes.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "fail",
      message
    );
  }
});

test("widget_file_ticket is called exactly when expected", () => {
  const filed = run({ tools: ["widget_file_ticket"] });
  assert.equal(
    gradeRun(filed, expecting({ fileTicket: true })).fileTicket,
    "pass"
  );
  assert.equal(
    gradeRun(filed, expecting({ fileTicket: false })).fileTicket,
    "fail"
  );
  assert.equal(
    gradeRun(run(), expecting({ fileTicket: true })).fileTicket,
    "fail"
  );
});

test("tool calls stay at or under the budget", () => {
  assert.equal(
    gradeRun(run(), expecting({ toolBudget: 2 })).toolBudget,
    "pass"
  );
  assert.equal(
    gradeRun(run(), expecting({ toolBudget: 1 })).toolBudget,
    "fail"
  );
});

test("step usage sums investigator step time, tokens and reported cost", () => {
  const step = (type: string, at: string, usage?: object) => ({
    data: { stepIndex: 0, turnId: "t", usage },
    meta: { at },
    type,
  });
  assert.deepEqual(
    stepUsage([
      step("step.started", "2026-10-04T00:00:00.000Z"),
      step("step.completed", "2026-10-04T00:00:02.500Z", {
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 20,
      }),
    ]),
    {
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
      priced: 1,
      stepMs: 2500,
      steps: 1,
      usageReported: 1,
    }
  );
});

test("foreign identifiers listed in expectations fail even when present in the cassette", () => {
  const foreign = "00000000-0000-4000-8000-000000000001";
  const message = `Campaign ${foreign} is paused.`;
  assert.equal(gradeRun(run({ message }), recorded).leaks, "pass");
  assert.equal(
    gradeRun(run({ message }), expecting({ foreignIdentifiers: [foreign] }))
      .leaks,
    "fail"
  );
});

test("raw-field checks cover quoted keys, spaced pairs and hyphen-adjacent camelCase", () => {
  for (const message of [
    '{"status": "error"}',
    "{status: error}",
    "dailyLimit: 30",
    "status_code: 500",
    "`status: error`",
    "dailyLimit-setting is reached.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "fail",
      message
    );
  }
  for (const message of [
    "Your campaign is paused. Open Campaign Options.",
    "What you can do: check the campaign status.",
    "Next step: open Settings.",
    "Note: reconnect your sending accounts.",
    "See https://help.acquisity.ai/campaigns for the steps.",
    "Open https://app.acquisity.ai/dashboard/aaron-fragas-workspace-wMUMT.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "pass",
      message
    );
  }
});

test("bold labels and merge tags are not raw fields; a real field still is", () => {
  for (const message of [
    "1. **Leads tab:** Make sure Leads Uploaded is above zero.",
    "Use {{sendingAccountFirstName}} in the signature, then click Save.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "pass",
      message
    );
  }
  for (const message of [
    "The record shows organization_id: 123.",
    "It saved sendingAccountId=abc.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "fail",
      message
    );
  }
});

test("bold raw keys and undocumented merge variables still fail the grader", () => {
  for (const message of [
    "**organization_id:** 123",
    "**sendingAccountId:** abc",
    "The internal field is {{sendingAccountId}}.",
  ]) {
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "fail",
      message
    );
  }
  for (const name of [
    "firstName",
    "lastName",
    "companyName",
    "industry",
    "jobTitle",
    "sendingAccountName",
    "sendingAccountFirstName",
  ]) {
    const message = `Use {{${name}}} in the email.`;
    assert.equal(
      gradeRun(run({ message }), recorded).rawFields,
      "pass",
      message
    );
  }
  assert.equal(
    gradeRun(run({ message: "**Leads tab:** Check uploaded leads." }), recorded)
      .rawFields,
    "pass"
  );
});

test("missing step usage is distinguishable from reported zero tokens", () => {
  const event = {
    data: {},
    meta: { at: "2026-10-04T00:00:00.000Z" },
    type: "step.completed",
  };
  assert.equal(stepUsage([event]).usageReported, 0);
  assert.equal(
    stepUsage([
      { ...event, data: { usage: { inputTokens: 0, outputTokens: 0 } } },
    ]).usageReported,
    1
  );
});

test("a run is scored only when every read came from the cassette", () => {
  const recordedCalls = recorded.cassette.map((entry) => ({
    output: entry.output,
    toolName: entry.tool,
  }));
  const controls = [
    { output: REPLAY_TICKET, toolName: "widget_file_ticket" },
    { output: { asked: "Which campaign?" }, toolName: "widget_ask_customer" },
  ];
  assert.deepEqual(
    unrecordedReads([...recordedCalls, ...controls], recorded),
    []
  );
  assert.deepEqual(
    unrecordedReads(
      [
        ...recordedCalls,
        { output: REPLAY_MISS, toolName: "widget_sdr_thread_status" },
        { output: { status: "ok" }, toolName: "widget_job_failures" },
      ],
      recorded
    ),
    ["widget_sdr_thread_status", "widget_job_failures"]
  );
});

test("replay assessment scores covered clean runs and leaves uncovered clean runs not scored", () => {
  const grades = gradeRun(
    run(),
    expecting({ fileTicket: false, toolBudget: 2 })
  );
  const covered = replayAssessment(grades, []);
  assert.equal(covered.scored, true);
  assert.equal(covered.outcome, "pass");
  assert.deepEqual(covered.checks, grades);
  // Behavior failures from a missing read must not grade an uncovered run.
  const uncovered = replayAssessment(
    { ...grades, lane: "fail", toolBudget: "fail" },
    ["widget_job_failures"]
  );
  assert.equal(uncovered.scored, false);
  assert.equal(uncovered.outcome, "not scored");
  assert.deepEqual(uncovered.checks, { leaks: "pass", rawFields: "pass" });
});

test("replay assessment fails uncovered leaks and raw fields while keeping them unscored", () => {
  for (const message of ["Open other-company.com.js.pdf.", "dailyLimit: 30"]) {
    const grades = gradeRun(run({ message }), recorded);
    const uncovered = replayAssessment(grades, ["widget_job_failures"]);
    assert.equal(uncovered.scored, false);
    assert.equal(uncovered.outcome, "fail");
    assert.deepEqual(uncovered.checks, {
      leaks: grades.leaks,
      rawFields: grades.rawFields,
    });
  }
});

test("a reply that repeats the previous one fails, ignoring case, spacing and punctuation", () => {
  const conversation = {
    ...recorded,
    question:
      "LATEST CUSTOMER MESSAGE (the one to work on):\nStill same day.\n\nEARLIER TURNS (context):\nCustomer: Why same day?\nSupport: Open the campaign.\nGo to Sequences, then edit the delay.",
  };
  assert.equal(
    gradeRun(
      run({
        message: "open the campaign. Go to sequences then edit the delay!",
      }),
      conversation
    ).repeat,
    "fail"
  );
  assert.equal(
    repeatsPreviousReply("Your delay is saved as 3 days.", conversation),
    "pass"
  );
  assert.equal(repeatsPreviousReply(null, conversation), "pass");
  assert.equal(
    repeatsPreviousReply("Open the campaign.", {
      ...recorded,
      question: "Why same day?",
    }),
    "not set"
  );
});

test("a handoff is the human lane or a reply held for a person, never a filed ticket", () => {
  assert.equal(handedOff("human", null), true);
  assert.equal(handedOff("investigate", "needs_human"), true);
  // A ticket filed with the reply allowed is not a person taking over.
  assert.equal(handedOff("investigate", "allow"), false);
});

test("leak scan owns the domain of an address in the evidence and what the customer wrote", () => {
  const evidence: WidgetCase = {
    ...recorded,
    cassette: [
      ...recorded.cassette,
      { ...recorded.cassette[0], output: "Sender\nsam@shop-one.co" },
    ],
    question: "A prospect asked who deals-two.com is.",
  };
  for (const message of [
    "The sam@shop-one.co inbox and other shop-one.co addresses are cancelled.",
    "Tell them deals-two.com is the address you send from.",
  ]) {
    assert.equal(gradeRun(run({ message }), evidence).leaks, "pass", message);
  }
  assert.equal(
    gradeRun(run({ message: "Write to other-company.com first." }), evidence)
      .leaks,
    "fail"
  );
});

test("Instantly may be named only when the case's own results show a connection the customer owns", () => {
  const owned = (accountType: string): WidgetCase => ({
    ...recorded,
    cassette: [
      ...recorded.cassette,
      {
        ...recorded.cassette[0],
        output: { connection: { accountType, isActive: true } },
      },
    ],
  });
  const message = "Your Instantly account rejected the connection.";
  // Legacy: the customer connected their own Instantly account.
  assert.equal(gradeRun(run({ message }), owned("user_owned")).leaks, "pass");
  // Pro: provisioned for them, so the name stays hidden.
  assert.equal(
    gradeRun(run({ message }), owned("system_provisioned")).leaks,
    "fail"
  );
  assert.equal(gradeRun(run({ message }), recorded).leaks, "fail");
});

test("a capitalized quoted UI label before a colon is not a raw key", () => {
  assert.equal(
    gradeRun(
      run({
        message:
          'The help center lists three options under "Sites" > "Domains": a live URL or your own domain.',
      }),
      recorded
    ).rawFields,
    "pass"
  );
  assert.equal(
    gradeRun(run({ message: '{"status": "error"}' }), recorded).rawFields,
    "fail"
  );
});

test("a url in the workspace's own read owns its bare domain, and no other", () => {
  // Round 15 run 3 (wrun ...STAT0M): the order read had the forwarding target as a www url.
  const withForward: WidgetCase = {
    ...recorded,
    cassette: [
      ...recorded.cassette,
      {
        input: {},
        output: { forwardTo: "https://www.forward-target.example" },
        tool: "widget_provisioning_status",
      } as WidgetCase["cassette"][number],
    ],
  };
  const message = "Your order forwards to forward-target.example.";
  assert.equal(gradeRun(run({ message }), recorded).leaks, "fail");
  assert.equal(gradeRun(run({ message }), withForward).leaks, "pass");
  assert.equal(
    gradeRun(
      run({ message: "It forwards to other-target.example." }),
      withForward
    ).leaks,
    "fail"
  );
});
