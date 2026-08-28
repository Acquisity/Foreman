import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { aiSdrReportWindows } from "../lib/ai-sdr-report-window.js";

/** The AI SDR feature channel this report posts into. */
const AI_SDR_CHANNEL = "C0BC0H4GA9J";

/**
 * 13:00 UTC every Monday, matching the daily reports' 09:00 America/New_York
 * slot. Vercel evaluates cron in UTC; a fixed expression cannot track daylight
 * saving, and drifting an hour earlier in winter is harmless for a weekly
 * summary whose point is the previous week, not the hour.
 */
export default defineSchedule({
  cron: "0 13 * * 1",
  run({ to, waitUntil, appAuth }) {
    const { report, previous, sameWeekLastMonth } = aiSdrReportWindows(
      new Date()
    );
    const dispatch = to(slack, { channelId: AI_SDR_CHANNEL }).send(
      `Weekly AI SDR performance report. Load the ai-sdr-report skill and follow it end to end. Report week is ${report.start} through ${report.end}; the previous-week comparison is ${previous.start} through ${previous.end}; the same-week-last-month comparison is ${sameWeekLastMonth.start} through ${sameWeekLastMonth.end}. Each timestamp bound uses ${report.endExclusive}, ${previous.endExclusive}, and ${sameWeekLastMonth.endExclusive} respectively as the exclusive end. Post one report in the skill's format.`,
      { auth: appAuth }
    );
    waitUntil(
      dispatch.catch((error) => {
        console.error("AI SDR report dispatch failed.", error);
      })
    );
  },
});
