import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { z } from "zod";
import { SUPPORT_CHANNEL, slackTimestamp } from "./config.js";

const responseSchema = z.object({ ok: z.literal(true) }).passthrough();
const messageSchema = z.object({
  app_id: z.string().optional(),
  attachments: z.array(z.unknown()).max(20).optional(),
  blocks: z.array(z.unknown()).max(100).optional(),
  client_msg_id: z.string().optional(),
  metadata: z
    .object({
      event_payload: z.record(z.string(), z.unknown()),
      event_type: z.string(),
    })
    .optional(),
  text: z.string().max(100_000).optional(),
  thread_ts: z.string().optional(),
  ts: slackTimestamp,
  user: z.string().optional(),
});
export type SupportSlackMessage = z.infer<typeof messageSchema>;

/** Channel is application-owned. No caller can override it or select a Slack method. */
async function slackRequest(
  operation:
    | "conversations.history"
    | "conversations.replies"
    | "chat.postMessage",
  input: Record<string, string>
) {
  const credentials = connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  );
  const token = await resolveSlackBotToken(credentials.botToken);
  const response = await fetch(`https://slack.com/api/${operation}`, {
    body: new URLSearchParams({ ...input, channel: SUPPORT_CHANNEL }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error("Support Slack access failed.");
  }
  const text = await response.text();
  if (text.length > 2_000_000) {
    throw new Error("Support Slack response exceeded its bound.");
  }
  return responseSchema.parse(JSON.parse(text));
}

export async function readSupportMessages(
  input: { oldest: string } | { thread: string }
): Promise<SupportSlackMessage[]> {
  const method =
    "thread" in input ? "conversations.replies" : "conversations.history";
  const args: Record<string, string> =
    "thread" in input
      ? { ts: slackTimestamp.parse(input.thread) }
      : { oldest: slackTimestamp.parse(input.oldest) };
  const messages: SupportSlackMessage[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Slack cursor depends on the previous page.
    const response = await slackRequest(method, {
      ...args,
      cursor,
      include_all_metadata: "true",
      limit: "100",
    });
    messages.push(...z.array(messageSchema).parse(response.messages));
    cursor =
      z
        .object({ next_cursor: z.string().optional() })
        .optional()
        .parse(response.response_metadata)?.next_cursor ?? "";
    if (!(cursor || response.has_more)) {
      return messages;
    }
  }
  throw new Error(
    "Support Slack history is incomplete; the cursor was not advanced."
  );
}

export async function postSupportMessage(
  thread: string,
  text: string,
  key: string
) {
  const response = await slackRequest("chat.postMessage", {
    client_msg_id: key,
    metadata: JSON.stringify({
      event_payload: { key },
      event_type: "foreman_support",
    }),
    text,
    thread_ts: slackTimestamp.parse(thread),
    unfurl_links: "false",
    unfurl_media: "false",
  });
  return slackTimestamp.parse(response.ts);
}
