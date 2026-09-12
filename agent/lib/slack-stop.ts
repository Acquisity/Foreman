import { createHash } from "node:crypto";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import type { MessageStreamEvent } from "eve/client";

const MAX_TEXT_LENGTH = 200;
const CANCELLATION_SNAPSHOT_EVENTS = 256;

const STOP_PATTERN =
  /^(?:<@[A-Za-z0-9]+(?:\|[^>]*)?>\s*)*(?:stop|cancel)(?:[\s.!?…]|<@[A-Za-z0-9]+(?:\|[^>]*)?>)*$/i;

/**
 * Whether a Slack message is a literal request to cancel the running turn.
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

const eventTurnId = (event: MessageStreamEvent): string | null => {
  // Deliberately allow only parent-owned event coordinates in Eve 0.54.2.
  // A generic data.turnId lookup also sees proxied child input/authorization
  // and subagent.called coordinates, which cannot select this session's owner.
  // Standalone parent epilogues may have an empty ID and are ignored too.
  // New event kinds require review before entering this allowlist.
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed":
    case "step.started":
    case "step.failed":
    case "message.received":
    case "message.appended":
    case "message.completed":
    case "reasoning.appended":
    case "reasoning.completed":
    case "actions.requested":
    case "action.input.appended":
    case "action.partial":
    case "action.result":
      return event.data.turnId || null;
    default:
      return null;
  }
};

/** Read only the already-observed tail; waiting does not retire its turn ID. */
const latestTurnAtTail = async (
  stream: ReadableStream<MessageStreamEvent>,
  count: number
): Promise<string | null> => {
  const reader = stream.getReader();
  let turnId: string | null = null;
  try {
    for (let remaining = count; remaining > 0; remaining -= 1) {
      // biome-ignore lint/performance/noAwaitInLoops: read the durable stream in order through the fixed snapshot tail.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      turnId = eventTurnId(value) ?? turnId;
    }
    return turnId;
  } finally {
    await reader.cancel();
  }
};

/**
 * Queue cancellation for this exact session and its background tasks. A parent
 * can be waiting after its turn completes while children still work, so retain
 * the latest turn ID as the stale-request guard. Accepted means requested,
 * not settled; native task cancellation need not emit parent turn.cancelled.
 */
export const cancelActiveSlackTurn = async (
  ctx: SlackInboundMessageContext
): Promise<string | null> => {
  const session = await ctx.resolveSession();
  if (!session) {
    return null;
  }
  const tailIndex = await session.getStreamTailIndex();
  if (tailIndex < 0) {
    return null;
  }
  const startIndex = Math.max(0, tailIndex + 1 - CANCELLATION_SNAPSHOT_EVENTS);
  const snapshot = await session.getEventStream({ startIndex });
  const turnId = await latestTurnAtTail(snapshot, tailIndex - startIndex + 1);
  if (!turnId) {
    return null;
  }
  const result = await session.cancel({ tasks: true, turnId });
  return result.status === "accepted" ? turnId : null;
};

const stopConfirmationId = (
  ctx: SlackInboundMessageContext,
  turnId: string
): string => {
  // Preserve the original byte encoding across rolling deployments. Slack
  // deduplicates retries by this id, so adding a namespace or trailing
  // separator would allow an old and a new handler to post twice.
  const hex = createHash("sha256")
    .update(ctx.slack.teamId ?? "")
    .update("\0")
    .update(ctx.slack.channelId)
    .update("\0")
    .update(ctx.slack.threadTs)
    .update("\0")
    .update(turnId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Posts one provider-idempotent acknowledgement for an accepted request. */
export const postStopConfirmation = async (
  ctx: SlackInboundMessageContext,
  turnId: string
): Promise<void> => {
  try {
    const response = await ctx.slack.request("chat.postMessage", {
      channel: ctx.slack.channelId,
      client_msg_id: stopConfirmationId(ctx, turnId),
      text: "Stop requested.",
      thread_ts: ctx.slack.threadTs,
    });
    if (response.ok) {
      return;
    }
  } catch {
    // The cancellation request has already been accepted. Eve catches an authored Slack
    // handler rejection after acknowledging the webhook, so throwing cannot
    // produce a useful retry and only misclassifies the accepted request.
  }
  console.warn("Slack stop confirmation could not be posted.");
};
