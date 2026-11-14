import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { deliverAiSdrReport } from "../lib/ai-sdr-report-delivery.js";
import { readAiSdrWeeklyReport } from "../lib/ai-sdr-weekly-report.js";
import { appProviderContext } from "../lib/executor/app-context.js";
import { PRODUCTION_READ_QUERY_ARGS } from "../lib/lookup-customer.js";
import { callPlanetscaleReadQuery } from "../lib/planetscale.js";
import { postSlackChannelMessage } from "../lib/slack-channel-post.js";
import { stampUnattended } from "../lib/trust.js";

/** The AI SDR feature channel this report posts into. */
const AI_SDR_CHANNEL = "C0BC0H4GA9J";

/** Bounds the three serial reads; each takes up to 50 s under Executor. */
const REPORT_TIMEOUT_MS = 180_000;

/**
 * 13:00 UTC every Monday, matching the daily reports' 09:00 America/New_York
 * slot. Vercel evaluates cron in UTC; a fixed expression cannot track daylight
 * saving, and drifting an hour earlier in winter is harmless for a weekly
 * summary whose point is the previous week, not the hour.
 */
export default defineSchedule({
  cron: "0 13 * * 1",
  run({ to, waitUntil, appAuth }) {
    const ctx = appProviderContext(AbortSignal.timeout(REPORT_TIMEOUT_MS));
    waitUntil(
      deliverAiSdrReport({
        dispatch: (prompt) =>
          to(slack, { channelId: AI_SDR_CHANNEL }).send(prompt, {
            auth: stampUnattended(appAuth),
          }),
        post: (text) => postSlackChannelMessage(AI_SDR_CHANNEL, { text }),
        read: () =>
          readAiSdrWeeklyReport(new Date(), (query) =>
            callPlanetscaleReadQuery(ctx, {
              ...PRODUCTION_READ_QUERY_ARGS,
              query,
            })
          ),
      }).catch(() => {
        // Fixed string only: never a Slack response body or provider message.
        console.error("AI SDR report delivery failed.");
      })
    );
  },
});
