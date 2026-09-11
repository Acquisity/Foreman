import { createHash } from "node:crypto";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import {
  isCurrentTurnBoundaryEvent,
  type MessageStreamEvent,
} from "eve/client";

const MAX_TEXT_LENGTH = 200;
const CANCELLATION_CONFIRMATION_TIMEOUT_MS = 10_000;

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
  if (!("data" in event) || typeof event.data !== "object") {
    return null;
  }
  if (!("turnId" in event.data) || typeof event.data.turnId !== "string") {
    return null;
  }
  return event.data.turnId;
};

const TURN_SNAPSHOT_WINDOW = 64;
type SlackSession = NonNullable<
  Awaited<ReturnType<SlackInboundMessageContext["resolveSession"]>>
>;

/** Read recent parent events first; child events do not identify the parent turn. */
const activeTurnAtTail = async (
  session: SlackSession,
  tailIndex: number,
  windowSize = 1
): Promise<string | null> => {
  const startIndex = Math.max(0, tailIndex - windowSize + 1);
  const stream = await session.getEventStream({ startIndex });
  const reader = stream.getReader();
  let active: string | null | undefined;
  try {
    for (let index = startIndex; index <= tailIndex; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: consume only the snapshotted window in stream order.
      const { done, value } = await reader.read();
      if (done) {
        return null;
      }
      if (
        isCurrentTurnBoundaryEvent(value) ||
        value.type === "turn.completed" ||
        value.type === "turn.failed" ||
        value.type === "turn.cancelled"
      ) {
        active = null;
      } else {
        const turnId = eventTurnId(value);
        if (turnId !== null) {
          active = turnId;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  if (active !== undefined) {
    return active;
  }
  // A window containing only forwarded child events needs an earlier parent
  // event. Do not use the child's nested turn id or guess the current turn.
  return startIndex === 0
    ? null
    : activeTurnAtTail(
        session,
        startIndex - 1,
        Math.max(TURN_SNAPSHOT_WINDOW, windowSize * 2)
      );
};

const confirmsCancellation = async (
  reader: ReadableStreamDefaultReader<MessageStreamEvent>,
  turnId: string
): Promise<boolean> => {
  const { done, value } = await reader.read();
  if (done) {
    return false;
  }
  const observedTurnId = eventTurnId(value);
  if (value.type === "turn.cancelled" && observedTurnId === turnId) {
    return true;
  }
  if (isCurrentTurnBoundaryEvent(value)) {
    return false;
  }
  return confirmsCancellation(reader, turnId);
};

/**
 * Cancels the exact active Slack turn and confirms its durable cancellation.
 *
 * `accepted` alone is insufficient because eve also accepts cancellation for
 * an already-parked session as a no-op. Snapshotting the active turn from the
 * durable stream, applying its id as a stale-request guard, and then observing
 * the matching `turn.cancelled` boundary avoids attributing another terminal
 * outcome to the stop command.
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
  const turnId = await activeTurnAtTail(session, tailIndex);
  if (!turnId) {
    return null;
  }

  // Open from the observed tail before requesting cancellation. The durable
  // cursor includes any terminal event that wins the race in between.
  const confirmation = await session.getEventStream({
    startIndex: tailIndex + 1,
  });
  const reader = confirmation.getReader();
  let confirmationTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await session.cancel({ turnId });
    if (result.status !== "accepted") {
      return null;
    }
    const confirmed = await Promise.race([
      confirmsCancellation(reader, turnId),
      new Promise<false>((resolve) => {
        confirmationTimeout = setTimeout(
          () => resolve(false),
          CANCELLATION_CONFIRMATION_TIMEOUT_MS
        );
        confirmationTimeout.unref?.();
      }),
    ]);
    return confirmed ? turnId : null;
  } finally {
    if (confirmationTimeout) {
      clearTimeout(confirmationTimeout);
    }
    await reader.cancel();
  }
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

/** Posts one provider-idempotent confirmation for an exact cancelled turn. */
export const postStopConfirmation = async (
  ctx: SlackInboundMessageContext,
  turnId: string
): Promise<void> => {
  try {
    const response = await ctx.slack.request("chat.postMessage", {
      channel: ctx.slack.channelId,
      client_msg_id: stopConfirmationId(ctx, turnId),
      text: "Stopped.",
      thread_ts: ctx.slack.threadTs,
    });
    if (response.ok) {
      return;
    }
  } catch {
    // The cancellation has already settled. Eve catches an authored Slack
    // handler rejection after acknowledging the webhook, so throwing cannot
    // produce a useful retry and only misclassifies the successful stop.
  }
  console.warn("Slack stop confirmation could not be posted.");
};
