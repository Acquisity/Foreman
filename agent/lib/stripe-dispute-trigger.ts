import type { SessionAuthContext } from "eve/context";
import { stampStripeDispute, stampTrusted, stampUnattended } from "./trust.js";

/**
 * The Acquisity Slack channel where Stripe dispute alerts land (ENG-16255).
 *
 * @remarks
 * Acquisity's dispute pipeline posts each alert through the same Slack app as
 * Foreman, so eve drops it from the mention, DM and message hooks as
 * self-authored. Foreman's `onEvent` picks it up instead, and
 * {@link isStripeDisputeAlert} decides which of those events starts a session.
 */
export const STRIPE_DISPUTES_CHANNEL = "C0CAEACAGPJ";

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
 * Whether one Slack message is a new dispute alert from this Slack app.
 *
 * @param channelId - The channel the message is in. Checked first, so every
 * event from every other channel returns at once.
 * @param message - The raw Slack message event, or a `conversations.replies`
 * message.
 * @param appId - This Slack app's id, from the signed envelope's
 * `api_app_id`. Comparing against it works for both the production and
 * Preview apps.
 */
export const isStripeDisputeAlert = (
  channelId: unknown,
  message: Record<string, unknown>,
  appId: unknown
): boolean => {
  if (channelId !== STRIPE_DISPUTES_CHANNEL) {
    return false;
  }
  if (message.type !== "message") {
    return false;
  }
  if (message.subtype !== undefined && message.subtype !== "bot_message") {
    return false;
  }
  if (message.thread_ts !== undefined && message.thread_ts !== message.ts) {
    return false;
  }
  if (typeof appId !== "string" || appId === "" || message.app_id !== appId) {
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
  const disputeId = lines.join("\n").match(DISPUTE_ID)?.[0];
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
  readonly teamId: string | undefined;
  readonly threadTs: string;
}): SessionAuthContext =>
  stampStripeDispute(
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

/** The first message of the session a new alert starts. */
export const stripeDisputeSessionMessage = (alert: string): string =>
  [
    "A new Stripe dispute alert was posted in this channel. Load the stripe-disputes skill and follow it end to end for this dispute. This session is automatic: stage evidence and post the ready message, never submit.",
    "",
    alert,
  ].join("\n");
