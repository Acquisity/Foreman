import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";

/** A schedule-owned message: plain fallback text, with optional Block Kit blocks. */
export interface SlackChannelMessage {
  blocks?: unknown[];
  text: string;
}

/**
 * Posts one message into a channel as the app's Slack bot, with no model
 * turn. Throws a fixed error, never the Slack response body, so a caller's
 * log line cannot carry provider text.
 */
export const postSlackChannelMessage = async (
  channel: string,
  message: SlackChannelMessage
): Promise<void> => {
  const token = await resolveSlackBotToken(
    connectSlackCredentials(
      process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
    ).botToken
  );
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    body: new URLSearchParams({
      ...(message.blocks ? { blocks: JSON.stringify(message.blocks) } : {}),
      channel,
      text: message.text,
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
    throw new Error("Slack refused the channel message.");
  }
};
