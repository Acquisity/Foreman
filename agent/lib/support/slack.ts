import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { z } from "zod";
import { linkTickets } from "../ticket-links.js";
import { SUPPORT_CHANNEL, slackTimestamp } from "./config.js";
import type { SupportCursor } from "./store.js";

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

/** History is newest-first. Timestamp bounds survive between cron runs. */
export async function readSupportIntake(
  checkpoint: SupportCursor,
  request = slackRequest
): Promise<{ messages: SupportSlackMessage[]; checkpoint: SupportCursor }> {
  const messages: SupportSlackMessage[] = [];
  const oldest = slackTimestamp.parse(checkpoint.oldest);
  let latest = checkpoint.scan_latest;
  let newest = checkpoint.scan_newest ?? oldest;
  for (let page = 0; page < 10; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each exclusive upper bound follows the previous page.
    const response = await request("conversations.history", {
      oldest,
      ...(latest ? { latest: slackTimestamp.parse(latest) } : {}),
      include_all_metadata: "true",
      inclusive: "false",
      limit: "100",
    });
    const batch = z.array(messageSchema).parse(response.messages);
    const more = Boolean(
      response.has_more ||
        z
          .object({ next_cursor: z.string().optional() })
          .optional()
          .parse(response.response_metadata)?.next_cursor
    );
    if (
      batch.some(
        (message) =>
          Number(message.ts) <= Number(oldest) ||
          (latest !== null && Number(message.ts) >= Number(latest))
      )
    ) {
      throw new Error("Support Slack history did not respect its scan bounds.");
    }
    messages.push(...batch);
    newest = batch.reduce(
      (value, message) =>
        Number(message.ts) > Number(value) ? message.ts : value,
      newest
    );
    if (!more) {
      return {
        checkpoint: { oldest: newest, scan_latest: null, scan_newest: null },
        messages,
      };
    }
    if (!batch.length) {
      throw new Error("Support Slack history could not advance its scan.");
    }
    latest = batch.reduce(
      (value, message) =>
        Number(message.ts) < Number(value) ? message.ts : value,
      batch[0].ts
    );
  }
  return {
    checkpoint: { oldest, scan_latest: latest, scan_newest: newest },
    messages,
  };
}

export async function postSupportMessage(
  thread: string,
  text: string,
  key: string,
  request: typeof slackRequest = slackRequest
) {
  const response = await request("chat.postMessage", {
    client_msg_id: key,
    metadata: JSON.stringify({
      event_payload: { key },
      event_type: "foreman_support",
    }),
    text: linkTickets(text, "slack"),
    thread_ts: slackTimestamp.parse(thread),
    unfurl_links: "false",
    unfurl_media: "false",
  });
  return slackTimestamp.parse(response.ts);
}
