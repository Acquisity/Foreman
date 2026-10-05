import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import {
  answeredLane,
  type GradedRun,
  gradeRun,
  stepUsage,
} from "./widget-graders.js";

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

test("unset expectations report not set, never pass", () => {
  const grades = gradeRun(run(), recorded);
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
