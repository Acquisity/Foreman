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

const statusTitles: Record<FinProbeResult["status"], string> = {
  completed: "Investigation complete",
  connected: "Connection test passed",
  failed: "Investigation unavailable",
  pending: "Investigation still running",
  unexpected_reply: "Connection test needs checking",
};

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

export interface FinSlackReceipt {
  channel: string;
  delivered: boolean;
  ts: string;
}

export async function postFinSlackReceipt(
  probe: string,
  request = slackRequest
): Promise<FinSlackReceipt | null> {
  const channel = process.env.FIN_FOREMAN_PREVIEW_SLACK_CHANNEL;
  if (!(channel && process.env.SLACK_CONNECTOR)) {
    return null;
  }
  try {
    const posted = await request("chat.postMessage", {
      channel,
      client_msg_id: probe,
      text: "Fin requested a workspace check. I’ll update this message with the result.",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    return { channel, delivered: false, ts: posted.ts };
  } catch {
    logOpsEvent("fin_preview_slack_failed", {
      message: "Fin preview Slack notification could not be delivered.",
    });
    return null;
  }
}

export async function updateFinSlackReceipt(
  receipt: FinSlackReceipt | null,
  outcome: Pick<FinProbeResult, "status" | "message"> | null,
  request = slackRequest
): Promise<void> {
  if (!receipt || receipt.delivered) {
    return;
  }
  try {
    const text = outcome
      ? `*${statusTitles[outcome.status]}*\n\n${outcome.message}`
      : "*Investigation unavailable*\n\nThe check could not be started or its result retrieved.";
    await request("chat.update", {
      channel: receipt.channel,
      text,
      ts: receipt.ts,
    });
    receipt.delivered = true;
  } catch {
    logOpsEvent("fin_preview_slack_failed", {
      message: "Fin preview Slack notification could not be delivered.",
    });
  }
}

export async function reportFinProbeToSlack(
  probe: string,
  result: Promise<FinProbeResult>,
  request = slackRequest
): Promise<void> {
  // Handle rejection immediately, even while Slack is loading its credentials.
  const observed = result.catch(() => null);
  const receipt = await postFinSlackReceipt(probe, request);
  await updateFinSlackReceipt(receipt, await observed, request);
}
