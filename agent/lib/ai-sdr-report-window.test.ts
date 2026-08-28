import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiSdrReportWindows,
  mostRecentFridayBefore,
} from "./ai-sdr-report-window.js";

// Monday 2026-08-31, midday UTC: the report covers Mon 08-24 through Fri 08-28.
const NOW = Date.parse("2026-08-31T12:00:00.000Z");

test("ai SDR report window", async (t) => {
  await t.test("report week is the Mon-Fri that just ended", () => {
    const { report } = aiSdrReportWindows(new Date(NOW));
    assert.equal(report.start, "2026-08-24");
    assert.equal(report.end, "2026-08-28");
    assert.equal(report.endExclusive, "2026-08-29");
  });

  await t.test("previous week is seven days earlier", () => {
    const { previous } = aiSdrReportWindows(new Date(NOW));
    assert.equal(previous.start, "2026-08-17");
    assert.equal(previous.end, "2026-08-21");
    assert.equal(previous.endExclusive, "2026-08-22");
  });

  await t.test("same week last month is 28 days earlier", () => {
    const { sameWeekLastMonth } = aiSdrReportWindows(new Date(NOW));
    assert.equal(sameWeekLastMonth.start, "2026-07-27");
    assert.equal(sameWeekLastMonth.end, "2026-07-31");
    assert.equal(sameWeekLastMonth.endExclusive, "2026-08-01");
  });

  await t.test("a Friday counts as the previous week, not the same day", () => {
    const friday = new Date(Date.parse("2026-08-28T09:00:00.000Z"));
    assert.equal(
      mostRecentFridayBefore(friday),
      Date.parse("2026-08-21T00:00:00.000Z")
    );
  });

  await t.test("a Sunday rolls back two days to Friday", () => {
    const sunday = new Date(Date.parse("2026-08-30T09:00:00.000Z"));
    assert.equal(
      mostRecentFridayBefore(sunday),
      Date.parse("2026-08-28T00:00:00.000Z")
    );
  });
});
