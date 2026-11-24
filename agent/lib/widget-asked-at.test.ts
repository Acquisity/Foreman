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
const UTC_INSTANT_LATE = /2026-11-25T02:30:00\.000Z \(UTC\)/u;
const ZONE_UNKNOWN = /time zone is unknown, so give each date as a date/u;
const CUSTOMER_ZONE_CLAIM = /in the customer's time zone/u;
const PACIFIC_TIME = /10:45 AM PST/u;
const ASKED_AT_RULE = /askedAt says when the customer asked/u;

test("the asked-at line gives the time in the customer's own zone and the instant", () => {
  const line = askedAtLine({ ...scope, officeHours: hours }, tuesdayMorning);
  assert.match(line, PACIFIC_TUESDAY);
  assert.match(line, PACIFIC_ZONE);
  assert.match(line, UTC_INSTANT);
  assert.match(line, COMPARE_RULE);
});

test("without the customer's zone the asked-at line says so and asks for plain dates", () => {
  const line = askedAtLine(
    { ...scope, officeHours: undefined },
    new Date("2026-11-25T02:30:00.000Z")
  );
  assert.match(line, UTC_INSTANT_LATE);
  assert.match(line, ZONE_UNKNOWN);
  assert.doesNotMatch(line, CUSTOMER_ZONE_CLAIM);
});

test("a teammate's inbox investigation does not take the viewer's zone as the customer's", () => {
  const line = askedAtLine(
    { ...scope, officeHours: hours, source: "inbox" },
    tuesdayMorning
  );
  assert.match(line, ZONE_UNKNOWN);
});

test("a live re-run keeps the recorded question's time and zone", () => {
  const line = askedAtLine(
    {
      ...scope,
      liveAsOf: "2026-11-24T18:45:00.000Z",
      officeHours: hours,
      source: "inbox",
    },
    new Date("2026-11-26T09:00:00.000Z")
  );
  assert.match(line, PACIFIC_TUESDAY);
  assert.match(line, UTC_INSTANT);
});

test("the composer request carries the asked-at line and the rule that reads it", () => {
  const line = askedAtLine({ ...scope, officeHours: hours }, tuesdayMorning);
  const request = composerRequest({ askedAt: line, question: "When is it?" });
  assert.match(JSON.stringify(request.messages[0].content), PACIFIC_TIME);
  assert.match(request.system, ASKED_AT_RULE);
});
