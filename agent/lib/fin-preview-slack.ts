import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";

export interface FinProbeResult {
  message: string;
  probe: string;
  run_handle?: string;
  session_id: string;
  status: "connected" | "completed" | "pending" | "unexpected_reply" | "failed";
}

const slackResponse = z.object({
  ok: z.literal(true),
  ts: z.string().min(1),
});

async function slackRequest(
  operation: "chat.postMessage" | "chat.update",
  input: Record<string, string>
) {
  const connector = process.env.SLACK_CONNECTOR;
  if (!connector) {
    throw new Error("Fin preview Slack connector is not configured.");
  }
  const credentials = connectSlackCredentials(connector);
  const token = await resolveSlackBotToken(credentials.botToken);
  const response = await fetch(`https://slack.com/api/${operation}`, {
    body: new URLSearchParams(input),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error("Fin preview Slack delivery failed.");
  }
  return slackResponse.parse(await response.json());
}

export async function reportFinProbeToSlack(
  probe: string,
  result: Promise<FinProbeResult>,
  request = slackRequest
): Promise<void> {
  // Handle rejection immediately, even while Slack is loading its credentials.
  const observed = result.catch(() => null);
  const channel = process.env.FIN_FOREMAN_PREVIEW_SLACK_CHANNEL;
  if (!(channel && process.env.SLACK_CONNECTOR)) {
    return;
  }
  try {
    const posted = await request("chat.postMessage", {
      channel,
      client_msg_id: probe,
      text: `Fin requested a Foreman run.\nProbe: ${probe}`,
      unfurl_links: "false",
      unfurl_media: "false",
    });
    const outcome = await observed;
    const text = outcome
      ? `Fin → Foreman: ${outcome.status}\n${outcome.message}\nSession: ${outcome.session_id || "not started"}\nProbe: ${probe}`
      : `Fin → Foreman: failed\nCould not start or observe the run.\nProbe: ${probe}`;
    await request("chat.update", { channel, text, ts: posted.ts });
  } catch {
    logOpsEvent("fin_preview_slack_failed", {
      message: "Fin preview Slack notification could not be delivered.",
    });
  }
}
