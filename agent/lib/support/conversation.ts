import { createHash } from "node:crypto";
import { z } from "zod";
import { conversationId } from "./config.js";
import type { SupportSlackMessage } from "./slack.js";

const CONVERSATION_PATH = /\/(?:conversation|conversations)\/(\d+)(?:\/|$)/;
const intercomLink = /https:\/\/app\.intercom\.com\/[^\s<>"|]+/g;

export function notificationConversation(
  message: SupportSlackMessage,
  appId: string
): string | null {
  if (
    message.app_id !== appId ||
    (message.thread_ts && message.thread_ts !== message.ts)
  ) {
    return null;
  }
  const content = JSON.stringify([
    message.text,
    message.attachments,
    message.blocks,
  ]);
  if (content.length > 100_000) {
    return null;
  }
  const ids = new Set<string>();
  for (const link of content.match(intercomLink) ?? []) {
    const url = new URL(link);
    if (!url.pathname.includes("/ls8uffkp/")) {
      continue;
    }
    const match = CONVERSATION_PATH.exec(url.pathname);
    const id = match?.[1] ?? url.searchParams.get("conversation");
    if (conversationId.safeParse(id).success) {
      ids.add(id as string);
    }
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** MCP content is data; reject incomplete or unrecognized status rather than guessing. */
export function providerData(data: unknown): unknown {
  const envelope = z
    .object({
      content: z
        .array(z.object({ text: z.string().optional(), type: z.string() }))
        .optional(),
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
    })
    .passthrough()
    .parse(data);
  if (envelope.isError) {
    throw new Error("Provider could not complete this read.");
  }
  if (envelope.structuredContent) {
    return envelope.structuredContent;
  }
  if (envelope.content) {
    const text = envelope.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return JSON.parse(text);
  }
  return envelope;
}

const author = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    type: z.string(),
  })
  .passthrough();
const conversationPart = z
  .object({
    author,
    body: z.string().nullable().optional(),
    created_at: z.number(),
    id: z.union([z.string(), z.number()]),
    part_type: z.string(),
  })
  .passthrough();
const conversationSchema = z
  .object({
    conversation_parts: z.object({
      conversation_parts: z.array(conversationPart),
      total_count: z.number().optional(),
    }),
    created_at: z.number(),
    id: conversationId,
    source: z
      .object({ author, body: z.string().nullable().optional() })
      .passthrough(),
    state: z.enum(["open", "closed", "snoozed"]),
    updated_at: z.number(),
  })
  .passthrough();

export function inspectConversation(data: unknown, expectedId: string) {
  const conversation = conversationSchema.parse(providerData(data));
  if (conversation.id !== expectedId) {
    throw new Error("Intercom returned a different conversation.");
  }
  const parts = conversation.conversation_parts.conversation_parts;
  if (
    (conversation.conversation_parts.total_count ?? parts.length) > parts.length
  ) {
    throw new Error("The conversation history is incomplete.");
  }
  const customer = parts.filter((p) =>
    ["user", "lead", "contact"].includes(p.author.type)
  );
  const lastCustomer = Math.max(
    conversation.created_at,
    ...customer.map((p) => p.created_at)
  );
  const humanReplied = parts.some(
    (p) =>
      p.author.type === "admin" &&
      p.part_type === "comment" &&
      p.created_at >= lastCustomer
  );
  const humanTookOwnership = parts.some(
    (p) =>
      p.author.type === "admin" &&
      p.part_type === "assignment" &&
      p.created_at >= lastCustomer
  );
  const version = createHash("sha256")
    .update(JSON.stringify([conversation.source, customer]))
    .digest("hex");
  const revision = createHash("sha256")
    .update(JSON.stringify(conversation))
    .digest("hex");
  return {
    closed: conversation.state === "closed",
    conversation,
    humanReplied,
    humanTookOwnership,
    revision,
    snoozed: conversation.state === "snoozed",
    version,
  };
}
