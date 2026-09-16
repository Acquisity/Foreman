import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";

export interface FinInvestigationResult {
  message: string;
  session_id: string;
  status: "completed" | "failed" | "pending";
}

export interface FinInvestigationSlackReceipt {
  channel: string;
  delivered: boolean;
  ts: string;
}

const slackResponse = z.object({ ok: z.literal(true), ts: z.string().min(1) });
const statusTitles: Record<FinInvestigationResult["status"], string> = {
  completed: "Investigation complete",
  failed: "Investigation unavailable",
  pending: "Investigation still running",
};

const escapeSlackText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

async function slackRequest(
  operation: "chat.postMessage" | "chat.update",
  input: Record<string, string>
) {
  const connector = process.env.SLACK_CONNECTOR;
  if (!connector) {
    throw new Error("Fin investigation Slack connector is not configured.");
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
    throw new Error("Fin investigation Slack delivery failed.");
  }
  return slackResponse.parse(await response.json());
}

export async function postFinInvestigationReceipt(
  requestId: string,
  request = slackRequest
): Promise<FinInvestigationSlackReceipt | null> {
  const channel = process.env.FIN_INVESTIGATION_SLACK_CHANNEL;
  if (!(channel && process.env.SLACK_CONNECTOR)) {
    return null;
  }
  try {
    const posted = await request("chat.postMessage", {
      channel,
      client_msg_id: requestId,
      text: "Fin requested a workspace investigation. I’ll update this message with the result.",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    return { channel, delivered: false, ts: posted.ts };
  } catch {
    logOpsEvent("fin.investigation.slack.failed", {
      message: "Fin investigation Slack notification could not be delivered.",
    });
    return null;
  }
}

export async function updateFinInvestigationReceipt(
  receipt: FinInvestigationSlackReceipt | null,
  outcome: Pick<FinInvestigationResult, "status" | "message"> | null,
  request = slackRequest
): Promise<void> {
  if (!receipt || receipt.delivered) {
    return;
  }
  try {
    const text = outcome
      ? `*${statusTitles[outcome.status]}*\n\n${escapeSlackText(outcome.message)}`
      : "*Investigation unavailable*\n\nThe investigation could not be started or completed.";
    // Temporary Preview experiment: test whether editing in a self-mention starts a Slack session.
    const probe =
      process.env.VERCEL_ENV === "preview" &&
      receipt.channel === "C0BUF4GU8C8" &&
      outcome?.status === "completed"
        ? "\n\n<@U0BTGKF57T7> Preview self-mention test: reply in this thread with SELF-MENTION RECEIVED only. Do not investigate, call tools, or tag yourself again."
        : "";
    await request("chat.update", {
      channel: receipt.channel,
      text: text + probe,
      ts: receipt.ts,
    });
    receipt.delivered = true;
  } catch {
    logOpsEvent("fin.investigation.slack.failed", {
      message: "Fin investigation Slack notification could not be delivered.",
    });
  }
}
