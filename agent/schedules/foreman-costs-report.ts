import { getToken as getConnectToken } from "@vercel/connect";
import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { defineSchedule } from "eve/schedules";
import { executorClient } from "../lib/executor/client.js";
import { ExecutorError } from "../lib/executor/transport.js";
import { readCostReport, renderCostCard } from "../lib/foreman-costs.js";

/** The override exists only so the Preview bot can post into its sandbox channel for UAT. */
const FOREMAN_COSTS_CHANNEL =
  process.env.FOREMAN_COSTS_CHANNEL ?? "C0BQJB3RX97";

/** Bounds every read; the Vercel reads take up to 50 s each under Executor. */
const REPORT_TIMEOUT_MS = 120_000;

/** Reads the report under the app principal and posts the card, with no model turn. */
const postCostReport = async (): Promise<void> => {
  const signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
  const report = await readCostReport(
    executorClient({
      abortSignal: signal,
      getToken: async () => {
        const connector = process.env.EXECUTOR_MCP_CONNECTOR;
        if (!connector) {
          throw new ExecutorError("executor_not_configured");
        }
        return {
          token: await getConnectToken(connector, { subject: { type: "app" } }),
        };
      },
    }),
    signal
  );
  const { metadata, text } = renderCostCard(report);
  const token = await resolveSlackBotToken(
    connectSlackCredentials(
      process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
    ).botToken
  );
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    body: new URLSearchParams({
      channel: FOREMAN_COSTS_CHANNEL,
      metadata: JSON.stringify(metadata),
      text,
      unfurl_links: "false",
      unfurl_media: "false",
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (
    !response.ok ||
    body.length > 1_000_000 ||
    (JSON.parse(body) as { ok?: unknown }).ok !== true
  ) {
    throw new Error("Slack refused the cost report.");
  }
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
