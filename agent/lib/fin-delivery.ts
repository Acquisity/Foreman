import { createHash } from "node:crypto";
import { z } from "zod";
import { readFinIntercom } from "./executor/dispatch.js";
import { type FinContext, finContextSchema } from "./fin-scope.js";
import { inspectConversation, providerData } from "./support/conversation.js";

/** Read native ownership and complete history. Bare assignments and private notes are not takeover. */
export async function inspectFinDelivery(
  context: FinContext,
  read = readFinIntercom,
  parentSignal?: AbortSignal
) {
  const scope = finContextSchema.parse(context);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(50_000)])
    : AbortSignal.timeout(50_000);
  const raw = await read("get_conversation", scope.conversationId, signal);
  const { conversation } = inspectConversation(raw, scope.conversationId);
  const owner = z
    .object({
      contacts: z.object({
        contacts: z.array(z.object({ id: z.string() })).length(1),
        total_count: z.literal(1).optional(),
      }),
      source: z.object({
        author: z.object({
          id: z.string(),
          type: z.enum(["user", "lead", "contact"]),
        }),
        url: z.string(),
      }),
    })
    .parse(conversation);
  const source = new URL(owner.source.url);
  if (
    owner.contacts.contacts[0].id !== scope.contactId ||
    owner.source.author.id !== scope.contactId ||
    source.origin !== scope.origin ||
    source.username ||
    source.password ||
    source.pathname.split("/")[1] !== "dashboard" ||
    source.pathname.split("/")[2] !== scope.organizationSlug
  ) {
    throw new Error("Conversation ownership changed.");
  }
  const contact = z
    .object({
      external_id: z.string(),
      id: z.string(),
      workspace_id: z.string(),
    })
    .parse(providerData(await read("get_contact", scope.contactId, signal)));
  if (
    contact.id !== scope.contactId ||
    contact.external_id !== scope.userId ||
    contact.workspace_id !== scope.intercomAppId
  ) {
    throw new Error("Conversation ownership changed.");
  }
  return {
    humanReplied: conversation.conversation_parts.conversation_parts.some(
      (part) =>
        part.author.type === "admin" &&
        (part.part_type === "comment" ||
          // Intercom can combine a public reply and assignment into one part.
          (part.part_type === "assignment" &&
            Boolean(
              part.body
                ?.replace(/<[^>]*>/g, "")
                .replace(/&nbsp;|&#160;/g, " ")
                .trim()
            )))
    ),
    // Message IDs identify retries; provider metadata and signed attachment URLs
    // can change without a new customer request. Keep support's revision separate.
    requestKey: createHash("sha256")
      .update(
        JSON.stringify([
          scope.conversationId,
          conversation.created_at,
          conversation.conversation_parts.conversation_parts
            .filter((part) =>
              ["user", "lead", "contact"].includes(part.author.type)
            )
            .map((part) => String(part.id))
            .sort(),
        ])
      )
      .digest("hex"),
  };
}

export const finDeliverySuppressed = {
  message: "",
  status: "suppressed" as const,
};
