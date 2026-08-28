import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aiSdrReportWindows } from "./ai-sdr-report-window.js";
import {
  aiSdrWeeklyReportQueries,
  readAiSdrWeeklyReport,
} from "./ai-sdr-weekly-report.js";

const NOW = new Date("2026-08-31T13:00:00.000Z");

describe("aiSdrWeeklyReportQueries", () => {
  test("uses three fixed aggregate reads", () => {
    const queries = aiSdrWeeklyReportQueries(aiSdrReportWindows(NOW));
    assert.equal(queries.length, 3);
    assert.ok(queries[0]?.includes("from outreach_campaign_metrics m"));
    assert.ok(queries[1]?.includes("from scheduling_appointment a"));
    assert.ok(queries[2]?.includes("from crm_message_thread t"));
    assert.ok(queries[1]?.includes("T00:00:00Z'::timestamptz"));
    assert.ok(
      queries[0]?.includes(
        "when c.email_scripts_method = 'lead_magnet' then 'lead-magnet'"
      )
    );
  });

  test("counts only live AI SDR appointments and attributes methods safely", () => {
    const bookingQuery =
      aiSdrWeeklyReportQueries(aiSdrReportWindows(NOW))[1] ?? "";
    assert.ok(
      bookingQuery.includes(
        "left join appointment_campaign ac on ac.appointment_id = a.id"
      )
    );
    assert.ok(bookingQuery.includes("a.origin = 'ai_sdr'"));
    assert.ok(bookingQuery.includes("a.deleted_at is null"));
    assert.ok(bookingQuery.includes("a.status = 'scheduled'"));
    assert.ok(bookingQuery.includes("select distinct on (t.appointment_id)"));
    assert.ok(!bookingQuery.includes("scheduling_external_booking"));
  });
});

describe("readAiSdrWeeklyReport", () => {
  test("shapes counts, rates, deltas, methods, and lifecycle deterministically", async () => {
    const calls: string[] = [];
    const responses = [
      JSON.stringify([
        {
          method: "__total__",
          month_positive: "8",
          month_replies: "20",
          month_sent: "200",
          previous_positive: "10",
          previous_replies: "25",
          previous_sent: "250",
          report_positive: "15",
          report_replies: "30",
          report_sent: "300",
        },
        {
          method: "podcast",
          month_positive: "4",
          month_replies: "8",
          month_sent: "80",
          previous_positive: "5",
          previous_replies: "10",
          previous_sent: "100",
          report_positive: "10",
          report_replies: "20",
          report_sent: "200",
        },
      ]),
      JSON.stringify([
        {
          method: "__total__",
          month_booked: "2",
          previous_booked: "4",
          report_booked: "6",
        },
        {
          method: "podcast",
          month_booked: "1",
          previous_booked: "2",
          report_booked: "5",
        },
      ]),
      JSON.stringify([
        { month: "20", previous: "25", report: "30", stage: "replied" },
        {
          month: "10",
          previous: "10",
          report: "15",
          stage: "slots_sent",
        },
        { month: "5", previous: "5", report: "6", stage: "booked" },
        { month: "4", previous: "4", report: "3", stage: "completed" },
      ]),
    ];

    const result = await readAiSdrWeeklyReport(NOW, (query) => {
      calls.push(query);
      return Promise.resolve(responses[calls.length - 1] ?? "[]");
    });

    assert.equal(calls.length, 3);
    assert.equal(result.success, true);
    if (!result.success) {
      return;
    }
    assert.deepEqual(result.windows.report, {
      end: "2026-08-28",
      endExclusive: "2026-08-29",
      start: "2026-08-24",
    });
    assert.deepEqual(result.volume.bookedMeetings, {
      momPercent: 200,
      previous: 4,
      report: 6,
      sameWeekLastMonth: 2,
      wowPercent: 50,
    });
    assert.equal(result.conversion.replyRate.report, 10);
    assert.equal(result.conversion.positiveReplyRate.report, 50);
    assert.equal(result.conversion.bookedMeetingRate.report, 40);
    assert.equal(result.campaignTypes[0]?.method, "podcast");
    assert.equal(result.campaignTypes[0]?.bookedMeetingRate.report, 50);
    assert.equal(result.campaignTypes[1]?.bookedMeetings.report, 0);
    assert.equal(result.lifecycle[4]?.count.report, 0);
    assert.equal(
      result.lifecycleConversion.bookedPerSlotsSent.wowPercentagePoints,
      -10
    );
    assert.equal(result.lifecycleConversion.completedPerBooked.report, 50);
  });

  test("uses n/a count deltas and zero rates for zero baselines", async () => {
    const responses = [
      JSON.stringify([
        {
          method: "__total__",
          month_positive: 0,
          month_replies: 0,
          month_sent: 0,
          previous_positive: 0,
          previous_replies: 0,
          previous_sent: 0,
          report_positive: 1,
          report_replies: 0,
          report_sent: 0,
        },
      ]),
      JSON.stringify([
        {
          method: "__total__",
          month_booked: 0,
          previous_booked: 0,
          report_booked: 1,
        },
      ]),
      "[]",
    ];
    let index = 0;
    const result = await readAiSdrWeeklyReport(NOW, () => {
      const response = responses[index] ?? "[]";
      index += 1;
      return Promise.resolve(response);
    });

    assert.equal(result.success, true);
    if (!result.success) {
      return;
    }
    assert.equal(result.volume.bookedMeetings.wowPercent, null);
    assert.equal(result.volume.bookedMeetings.momPercent, null);
    assert.equal(result.volume.replies.wowPercent, 0);
    assert.equal(result.conversion.bookedMeetingRate.report, 100);
    assert.equal(result.conversion.replyRate.report, 0);
  });

  test("fails closed when a production read fails", async () => {
    const result = await readAiSdrWeeklyReport(NOW, () =>
      Promise.reject(new Error("database unavailable"))
    );
    assert.deepEqual(result, {
      error: "database unavailable",
      success: false,
    });
  });
});
