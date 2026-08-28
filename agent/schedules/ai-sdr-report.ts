import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { stampUnattended } from "../lib/trust.js";

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
    try {
      const dispatch = to(slack, { channelId: AI_SDR_CHANNEL }).send(
        "Weekly AI SDR performance report. Load the ai-sdr-report skill and follow it end to end. Call the fixed report tool once, then post one report in the approved Slack-table format.",
        { auth: stampUnattended(appAuth) }
      );
      waitUntil(
        dispatch.catch((error) => {
          console.error("AI SDR report dispatch failed.", error);
        })
      );
    } catch (error) {
      console.error("AI SDR report setup failed.", error);
    }
  },
});
