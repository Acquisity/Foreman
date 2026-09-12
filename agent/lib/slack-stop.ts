import { createHash } from "node:crypto";
import type { SlackInboundMessageContext } from "eve/channels/slack";

const MAX_TEXT_LENGTH = 200;

const STOP_PATTERN =
  /^(?:<@[A-Za-z0-9]+(?:\|[^>]*)?>\s*)*(?:stop|cancel)(?:[\s.!?…]|<@[A-Za-z0-9]+(?:\|[^>]*)?>)*$/i;

/**
 * Whether a Slack message is a literal request to retire the current session.
 * Only a message that consists of the word `stop` or `cancel`, optional bot
 * mentions such as `<@U123>` at either edge, surrounding whitespace, and
 * terminal punctuation qualifies; case does not matter. Longer requests such
 * as `stop the deploy` are ordinary text and never cancel anything. One
 * anchored pattern matches the whole message, so a mention cannot sit inside
 * the word, and input is length-bounded before matching.
 */
export const isStopRequest = (text: string): boolean =>
  text.length > 0 &&
  text.length <= MAX_TEXT_LENGTH &&
  STOP_PATTERN.test(text.trim());

/**
 * Retire the exact session, including a parent parked while children work.
 * Cancelling tasks alone lets their cancellation results wake the parent into
 * another turn. Reset directly; the next Slack message starts fresh with
 * visible history, without restoring hidden state or sandbox files.
 */
export const stopSlackSession = async (
  ctx: SlackInboundMessageContext
): Promise<string | null> => {
  const session = await ctx.resolveSession();
  if (!session) {
    return null;
  }
  const result = await session.reset({ reason: "Slack stop requested." });
  return result.status === "reset" ? result.previousSessionId : null;
};

const stopConfirmationId = (
  ctx: SlackInboundMessageContext,
  sessionId: string
): string => {
  // Key by retired session: retries share one acknowledgement, while a fresh
  // session in the same Slack thread gets its own confirmation.
  const hex = createHash("sha256")
    .update(ctx.slack.teamId ?? "")
    .update("\0")
    .update(ctx.slack.channelId)
    .update("\0")
    .update(ctx.slack.threadTs)
    .update("\0")
    .update(sessionId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Posts one provider-idempotent acknowledgement for a successful reset. */
export const postStopConfirmation = async (
  ctx: SlackInboundMessageContext,
  sessionId: string
): Promise<void> => {
  try {
    const response = await ctx.slack.request("chat.postMessage", {
      channel: ctx.slack.channelId,
      client_msg_id: stopConfirmationId(ctx, sessionId),
      text: "Stop requested.",
      thread_ts: ctx.slack.threadTs,
    });
    if (response.ok) {
      return;
    }
  } catch {
    // The session has already been retired. Eve catches an authored Slack
    // handler rejection after acknowledging the webhook, so throwing cannot
    // produce a useful retry and only misclassifies the successful reset.
  }
  console.warn("Slack stop confirmation could not be posted.");
};
