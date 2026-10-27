import type { SessionAuthContext } from "eve/context";
import {
  stampStripeDispute,
  stampStripeDisputeId,
  stampTrusted,
  stampUnattended,
} from "./trust.js";

/**
 * The Acquisity Slack channel where Stripe dispute alerts land (ENG-16255).
 *
 * @remarks
 * Acquisity's dispute pipeline posts each alert as the Dispute Alerts Slack
 * app and tags Foreman in it. Only a mention reaches Foreman: Slack and
 * Vercel Connect deliver no untagged message from this private channel, and
 * no message an app posts reaches that same app. Foreman's mention dispatch
 * hands the alert to {@link isStripeDisputeAlert}.
 */
export const STRIPE_DISPUTES_CHANNEL = "C0CAEACAGPJ";

/**
 * The Dispute Alerts Slack app (`slack/dispute-alerts` in Vercel Connect).
 * Production and Preview Foreman both trust alerts from this one app.
 */
export const STRIPE_DISPUTE_ALERTS_APP = "A0CCMSPF3AQ";

const ALERT_HEADER = "Stripe dispute opened";
const DISPUTE_ID = /du_[A-Za-z0-9]{1,64}/u;
const MAX_LINE = 1000;
const MAX_ALERT = 6000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value.text === "string"
    ? value.text
    : undefined;
};

const blocksOf = (
  message: Record<string, unknown>
): Record<string, unknown>[] =>
  Array.isArray(message.blocks) ? message.blocks.filter(isRecord) : [];

/**
 * Whether one Slack message is a new dispute alert from the Dispute Alerts app.
 *
 * @param channelId - The channel the message is in. Checked first, so every
 * message from every other channel returns at once.
 * @param message - The raw Slack message, from a mention or from
 * `conversations.replies`.
 */
export const isStripeDisputeAlert = (
  channelId: unknown,
  message: Record<string, unknown>
): boolean => {
  if (channelId !== STRIPE_DISPUTES_CHANNEL) {
    return false;
  }
  if (message.type !== "message" && message.type !== "app_mention") {
    return false;
  }
  if (message.subtype !== undefined && message.subtype !== "bot_message") {
    return false;
  }
  if (message.thread_ts !== undefined && message.thread_ts !== message.ts) {
    return false;
  }
  if (message.app_id !== STRIPE_DISPUTE_ALERTS_APP) {
    return false;
  }
  return blocksOf(message).some(
    (block) =>
      block.type === "header" && textOf(block.text)?.includes(ALERT_HEADER)
  );
};

const bounded = (text: string) =>
  text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)} [cut]` : text;

/**
 * The alert as bounded plain text for the model: the dispute id first, then
 * the fallback text and the text of each block.
 *
 * @remarks
 * Today the `du_` id appears only in the context block's "Open in Stripe"
 * link, so it is pulled out and stated on the first line, where no length cap
 * can cut it.
 */
export const alertDisputeId = (
  message: Record<string, unknown>
): string | undefined =>
  [
    textOf(message),
    ...blocksOf(message).flatMap((block) => [
      textOf(block.text),
      ...(Array.isArray(block.fields) ? block.fields.map(textOf) : []),
      ...(Array.isArray(block.elements) ? block.elements.map(textOf) : []),
    ]),
  ]
    .join("\n")
    .match(DISPUTE_ID)?.[0];

export const renderStripeDisputeAlert = (
  message: Record<string, unknown>
): string => {
  const lines: string[] = [];
  const fallback = textOf(message);
  if (fallback) {
    lines.push(fallback);
  }
  for (const block of blocksOf(message)) {
    const parts = [
      textOf(block.text),
      ...(Array.isArray(block.fields) ? block.fields.map(textOf) : []),
      ...(Array.isArray(block.elements) ? block.elements.map(textOf) : []),
    ];
    for (const part of parts) {
      if (part) {
        lines.push(part);
      }
    }
  }
  const body = lines.map(bounded).join("\n").slice(0, MAX_ALERT);
  const disputeId = alertDisputeId(message);
  return [
    `Dispute id: ${disputeId ?? "not found in the alert"}`,
    "Alert text:",
    body,
  ].join("\n");
};

/**
 * Auth for the session a new alert starts.
 *
 * @remarks
 * Nobody is watching it, so it is stamped unattended as well as trusted, and
 * carries the dispute marker that lets `respond_stripe_dispute` stage
 * evidence. It never carries investigation memory, intake-only or
 * questions-only. It is not a Slack user, so the tool's submit gate, which
 * needs a person in the channel, never opens for it.
 */
export const stripeDisputeSessionAuth = (input: {
  readonly disputeId: string | undefined;
  readonly teamId: string | undefined;
  readonly threadTs: string;
}): SessionAuthContext => {
  const auth = stampStripeDispute(
    stampUnattended(
      stampTrusted({
        attributes: {
          channel_id: STRIPE_DISPUTES_CHANNEL,
          thread_ts: input.threadTs,
          ...(input.teamId ? { team_id: input.teamId } : {}),
        },
        authenticator: "stripe-dispute-alert",
        issuer: input.teamId ? `slack:${input.teamId}` : "slack",
        principalId: "foreman:stripe-dispute-alert",
        principalType: "service",
      })
    )
  );
  return input.disputeId ? stampStripeDisputeId(auth, input.disputeId) : auth;
};

/** The first message of the session a new alert starts. */
export const stripeDisputeSessionMessage = (alert: string): string =>
  [
    "A new Stripe dispute alert was posted in this channel. Load the stripe-disputes skill and follow it end to end for this dispute. This session is automatic: stage evidence and post the ready message, never submit.",
    "",
    alert,
  ].join("\n");

const MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>/gu;

/**
 * Whether a person's thread reply is a literal approval: "approve" with only
 * mentions, case and closing punctuation around it. Anything else, a question
 * or "approve but change X", is not.
 */
export const isStripeDisputeApprovalText = (text: string): boolean =>
  text.length <= 200 &&
  text
    .replace(MENTION, "")
    .trim()
    .replace(/[.!]+$/u, "")
    .toLowerCase() === "approve";
