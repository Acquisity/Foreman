import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { askedAtLine } from "./widget-asked-at.js";
import { composerRequest } from "./widget-egress.js";
import type { OfficeHours } from "./widget-scope.js";

const hours: OfficeHours = {
  customerTimeZone: "America/Los_Angeles",
  enabled: false,
  nextOpenAt: null,
  nextOpenText: null,
  open: true,
  replyTimeMinutes: 20,
  replyTimeText: "20 minutes",
  showReplyTime: true,
  timeZone: "America/New_York",
};
const tuesdayMorning = new Date("2026-11-24T18:45:00.000Z");
const PACIFIC_TUESDAY = /Tuesday, November 24, 2026 at 10:45 AM PST/u;
const PACIFIC_ZONE = /\(America\/Los_Angeles\)/u;
const UTC_INSTANT = /2026-11-24T18:45:00\.000Z/u;
const COMPARE_RULE = /today, tomorrow/u;
const UTC_WEDNESDAY = /Wednesday, November 25, 2026 at 2:30 AM UTC/u;
const PACIFIC_TIME = /10:45 AM PST/u;
const ASKED_AT_RULE = /askedAt says when the customer asked/u;

test("the asked-at line gives the customer's own date, so a meeting on the 25th reads as tomorrow", () => {
  const line = askedAtLine({ ...scope, officeHours: hours }, tuesdayMorning);
  assert.match(line, PACIFIC_TUESDAY);
  assert.match(line, PACIFIC_ZONE);
  assert.match(line, UTC_INSTANT);
  assert.match(line, COMPARE_RULE);
});

test("the asked-at line falls back to UTC without the customer's zone", () => {
  const line = askedAtLine(
    { ...scope, officeHours: undefined },
    new Date("2026-11-25T02:30:00.000Z")
  );
  assert.match(line, UTC_WEDNESDAY);
});

test("the composer reads the asked-at line with the findings", () => {
  const line = askedAtLine({ ...scope, officeHours: hours }, tuesdayMorning);
  const request = composerRequest({ askedAt: line, question: "When is it?" });
  assert.match(JSON.stringify(request.messages[0].content), PACIFIC_TIME);
  assert.match(request.system, ASKED_AT_RULE);
});
