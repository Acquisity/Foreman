import { createHash } from "node:crypto";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import {
  isCurrentTurnBoundaryEvent,
  type MessageStreamEvent,
} from "eve/client";

const MAX_TEXT_LENGTH = 200;

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

const readActiveTurn = async (
  reader: ReadableStreamDefaultReader<MessageStreamEvent>,
  remaining: number,
  activeTurnId: string | null
): Promise<string | null> => {
  if (remaining === 0) {
    return activeTurnId;
  }
  const { done, value } = await reader.read();
  if (done) {
    return null;
  }
  let nextActiveTurnId = activeTurnId;
  if (value.type === "turn.started") {
    nextActiveTurnId = value.data.turnId;
  } else if (isCurrentTurnBoundaryEvent(value)) {
    nextActiveTurnId = null;
  }
  return readActiveTurn(reader, remaining - 1, nextActiveTurnId);
};

/** Reads the durable stream through an already-observed tail. */
const activeTurnAtTail = async (
  stream: ReadableStream<MessageStreamEvent>,
  tailIndex: number
): Promise<string | null> => {
  const reader = stream.getReader();
  try {
    return await readActiveTurn(reader, tailIndex + 1, null);
  } finally {
    await reader.cancel();
  }
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
  const snapshot = await session.getEventStream({ startIndex: 0 });
  const turnId = await activeTurnAtTail(snapshot, tailIndex);
  if (!turnId) {
    return null;
  }

  // Open from the observed tail before requesting cancellation. The durable
  // cursor includes any terminal event that wins the race in between.
  const confirmation = await session.getEventStream({
    startIndex: tailIndex + 1,
  });
  const reader = confirmation.getReader();
  try {
    const result = await session.cancel({ turnId });
    if (result.status !== "accepted") {
      return null;
    }
    return (await confirmsCancellation(reader, turnId)) ? turnId : null;
  } finally {
    await reader.cancel();
  }
};

const stopConfirmationId = (
  ctx: SlackInboundMessageContext,
  turnId: string
): string => {
  const hex = createHash("sha256")
    .update(ctx.slack.teamId ?? "")
    .update("\0")
    .update(ctx.slack.channelId)
    .update("\0")
    .update(ctx.slack.threadTs)
    .update("\0")
    .update(turnId)
    .digest()
    .toString("hex");
  // Slack clients use UUID-shaped client_msg_id values. Fix the version and
  // variant nibbles while retaining the remaining deterministic hash payload.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Posts one provider-idempotent confirmation for an exact cancelled turn. */
export const postStopConfirmation = async (
  ctx: SlackInboundMessageContext,
  turnId: string
): Promise<void> => {
  const response = await ctx.slack.request("chat.postMessage", {
    channel: ctx.slack.channelId,
    client_msg_id: stopConfirmationId(ctx, turnId),
    text: "Stopped.",
    thread_ts: ctx.slack.threadTs,
  });
  if (!response.ok) {
    throw new Error("Slack could not post the stop confirmation.");
  }
};
