import assert from "node:assert/strict";
import { test } from "node:test";

import type { WidgetInput } from "./widget-investigation.js";
import { readsTimeline, withTimeline } from "./widget-timeline.js";

const TRACE_IN_EVIDENCE =
  /trace link it carries in that fact's evidence reference/u;
const CITES_TIMELINE = /tool user_timeline/u;
const NAMES_TRIMMED = /named under trimmed/u;
const NAMES_CONNECTION = /internet connection was slow/u;
const NO_IDENTIFIERS = /no field names, step names, codes or identifiers/u;
const NO_LINKS = /no links/u;
const MENTIONS_TRACE = /trace/u;
const ids = {
  conversation_id: "6f1c1a52-0d6b-4c55-9f43-3a1c2c3f0a11",
  organization_id: "0b8f2e0e-9a55-4b1e-8d8c-7d0f6f5f2b22",
};
const start: WidgetInput = {
  ...ids,
  action: "start",
  message_id: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
  question: "Why was this call slow?",
};
const timeline = {
  callSteps: [{ elapsedMs: 6100, step: "sdk_connect", stepMs: 4200 }],
  networkTypes: ["3g"],
  trimmed: ["requests"],
};

test("only an investigation start reads the timeline", () => {
  assert.equal(readsTimeline(start), false);
  assert.equal(readsTimeline({ ...start, mode: "investigate" }), true);
  assert.equal(readsTimeline({ ...start, staff: true }), true);
  assert.equal(readsTimeline({ ...start, recording: { id: "rec_1" } }), true);
  assert.equal(
    readsTimeline({
      ...ids,
      action: "result",
      run_id: "2f3e4d5c-6b7a-4899-8a0b-2c3d4e5f6a7b",
      staff: true,
    }),
    false
  );
});

test("a question without a timeline is unchanged", () => {
  assert.equal(withTimeline("Why?", undefined, true), "Why?");
  assert.equal(withTimeline("Why?", undefined, false), "Why?");
});

test("a teammate is told to name the slow step and keep its trace link in the evidence", () => {
  const question = withTimeline("Why?", timeline, true);
  assert.ok(question.startsWith("Why?\n\nUSER TIMELINE"));
  assert.ok(question.endsWith(JSON.stringify(timeline)));
  assert.match(question, TRACE_IN_EVIDENCE);
  assert.match(question, CITES_TIMELINE);
  assert.match(question, NAMES_TRIMMED);
});

test("a customer is told to explain a user-side cause without identifiers or links", () => {
  const question = withTimeline("Why?", timeline, false);
  assert.ok(question.endsWith(JSON.stringify(timeline)));
  assert.match(question, NAMES_CONNECTION);
  assert.match(question, NO_IDENTIFIERS);
  assert.match(question, NO_LINKS);
  assert.match(question, NAMES_TRIMMED);
  assert.doesNotMatch(question, MENTIONS_TRACE);
});
