import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { scanIdentifiers } from "./widget-egress.js";
import {
  backAtLine,
  officeSchedule,
  ticketInsteadOfHandoff,
} from "./widget-office-hours.js";
import type { OfficeHours } from "./widget-scope.js";

const closed: OfficeHours = {
  customerTimeZone: "America/New_York",
  enabled: true,
  nextOpenAt: "2026-10-19T13:00:00.000Z",
  nextOpenText: "Monday, Oct 19 at 9:00 AM EDT",
  open: false,
  replyTimeMinutes: 20,
  replyTimeText: "20 minutes",
  showReplyTime: true,
  timeZone: "America/New_York",
};
const ticket = { summary: "The customer asked for a person.", title: "Away" };
const ids = { runId: "run-1" };
const filer = (result: object) => {
  const calls: unknown[] = [];
  const file = ((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(result);
  }) as never;
  return { calls, file };
};
const filed = { existing: false, identifier: "ENG-1", refund: false, url: "u" };

test("the after-hours line names the app's back-at time only when reply times are shown, and carries nothing the scans refuse", () => {
  assert.equal(
    backAtLine(closed),
    "Our team is away right now. We're back Monday, Oct 19 at 9:00 AM EDT, and a teammate will pick this up then."
  );
  const timeless = backAtLine({ ...closed, showReplyTime: false });
  assert.equal(
    timeless,
    "Our team is away right now, and a teammate will pick this up when they're back."
  );
  for (const line of [backAtLine(closed), timeless]) {
    const { candidates, internal } = scanIdentifiers(line);
    assert.deepEqual(internal, []);
    assert.deepEqual(Object.values(candidates).flat(), []);
  }
});

test("only a customer turn after hours files the ticket in place of a handoff", async () => {
  const skipped = [
    scope,
    { ...scope, officeHours: { ...closed, open: true } },
    { ...scope, officeHours: closed, source: "inbox" as const },
  ].map(async (context) => {
    const { calls, file } = filer(filed);
    assert.equal(
      await ticketInsteadOfHandoff(context, ticket, ids, undefined, file),
      null
    );
    assert.equal(calls.length, 0);
  });
  await Promise.all(skipped);
  const { calls, file } = filer(filed);
  assert.equal(
    await ticketInsteadOfHandoff(
      { ...scope, officeHours: closed },
      ticket,
      ids,
      undefined,
      file
    ),
    backAtLine(closed)
  );
  assert.equal(calls.length, 1);
});

test("a ticket that cannot be filed leaves the handoff in place", async () => {
  const away = { ...scope, officeHours: closed };
  const refused = filer({ error: "Linear did not accept the ticket." });
  assert.equal(
    await ticketInsteadOfHandoff(away, ticket, ids, undefined, refused.file),
    null
  );
  const thrown = (() => Promise.reject(new Error("down"))) as never;
  assert.equal(
    await ticketInsteadOfHandoff(away, ticket, ids, undefined, thrown),
    null
  );
});

test("the writers' schedule note states the app's hours, zone and closures, and is absent with office hours off or any part missing", () => {
  const schedule = {
    hoursText: [
      "Monday–Friday: 9:00 AM–5:00 PM",
      "Saturday: 10:00 PM–2:00 AM (next day)",
    ],
    timeZoneName: "Eastern Time",
    upcomingClosures: [
      { date: "2026-11-26", hours: "Closed all day", label: "Thanksgiving" },
      { date: "2026-12-24", hours: "9:00 AM–12:00 PM", label: null },
    ],
  };
  const note = officeSchedule({
    ...scope,
    officeHours: { ...closed, ...schedule },
  });
  assert.ok(
    note?.startsWith(
      "The support team's hours, from the app, in Eastern Time: Monday–Friday: 9:00 AM–5:00 PM; Saturday: 10:00 PM–2:00 AM (next day)."
    )
  );
  assert.ok(
    note?.includes(
      "Closures in the next 90 days: 2026-11-26 (Thanksgiving): Closed all day; 2026-12-24: 9:00 AM–12:00 PM."
    )
  );
  assert.ok(note?.includes("The team is away right now."));
  const open = officeSchedule({
    ...scope,
    officeHours: { ...closed, ...schedule, open: true, upcomingClosures: [] },
  });
  assert.ok(open?.includes("No closures are scheduled in the next 90 days."));
  assert.ok(open?.includes("The team is open right now."));
  for (const officeHours of [
    undefined,
    closed,
    { ...closed, ...schedule, enabled: false },
    { ...closed, ...schedule, hoursText: [] },
    { ...closed, ...schedule, timeZoneName: undefined },
    { ...closed, ...schedule, upcomingClosures: undefined },
  ]) {
    assert.equal(officeSchedule({ ...scope, officeHours }), null);
  }
  assert.equal(
    officeSchedule({
      ...scope,
      officeHours: { ...closed, ...schedule },
      source: "inbox",
    }),
    null
  );
});
