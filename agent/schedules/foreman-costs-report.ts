import { defineSchedule } from "eve/schedules";
import { appProviderContext } from "../lib/executor/app-context.js";
import { executorClient } from "../lib/executor/client.js";
import { readCostReport, renderCostBlocks } from "../lib/foreman-costs.js";
import { postSlackChannelMessage } from "../lib/slack-channel-post.js";

/** The override exists only so the Preview bot can post into its sandbox channel for UAT. */
const FOREMAN_COSTS_CHANNEL =
  process.env.FOREMAN_COSTS_CHANNEL ?? "C0BQJB3RX97";

/** Bounds every read; the Vercel reads take up to 50 s each under Executor. */
const REPORT_TIMEOUT_MS = 120_000;

/** Reads the report under the app principal and posts the message, with no model turn. */
const postCostReport = async (): Promise<void> => {
  const signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
  const report = await readCostReport(
    executorClient(appProviderContext(signal)),
    signal
  );
  await postSlackChannelMessage(
    FOREMAN_COSTS_CHANNEL,
    renderCostBlocks(report)
  );
};

/**
 * 13:05 UTC every day. Yesterday is closed on both billing sources by then:
 * FOCUS rows are Pacific days that end at 07:00 or 08:00 UTC, and the gateway
 * report is in UTC. Vercel fires every task sharing a cron string together, so
 * this stays off the SLA report's 13:00 slot; a manual trigger here must not
 * post the SLA report into product channels.
 */
export default defineSchedule({
  cron: "5 13 * * *",
  run({ waitUntil }) {
    waitUntil(
      postCostReport().catch(() => {
        // Fixed string only: never a Slack response body or provider message.
        console.error("Foreman cost report failed.");
      })
    );
  },
});
