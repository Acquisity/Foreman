import { createHash } from "node:crypto";
import type { Session } from "eve/channels";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import {
  isCurrentTurnBoundaryEvent,
  type MessageStreamEvent,
} from "eve/client";
import { logOpsEvent } from "./ops-log.js";
import { stableSlackClientMessageId } from "./slack-message-id.js";

const MAX_TEXT_LENGTH = 200;
/** Events read back from the durable tail to find the active turn. */
const ACTIVE_TURN_WINDOW = 64;
const TURN_END_TYPES = new Set([
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
]);

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

/**
 * Finds the active turn from the last few events of the durable stream: the
 * turn a `turn.started` in the window opened, or the turn the window's
 * events belong to when it started before the window, unless a turn end or
 * a session boundary follows. The read is bounded on purpose. A long turn's
 * stream runs to hundreds of megabytes, and reading it from index 0 inside
 * the Slack webhook handler, which is what the stop path did before, is the
 * likeliest reason the stop of 2026-09-03 never reached eve.
 */
export const activeSlackTurn = async (
  session: Session
): Promise<string | null> => {
  const tailIndex = await session.getStreamTailIndex();
  if (tailIndex < 0) {
    return null;
  }
  const startIndex = Math.max(0, tailIndex - ACTIVE_TURN_WINDOW + 1);
  let remaining = tailIndex - startIndex + 1;
  let active: string | null = null;
  let ended: string | null = null;
  // Breaking out closes the reader, which is what bounds a live stream that
  // stays open past the tail.
  for await (const event of await session.getEventStream({ startIndex })) {
    const turnId = eventTurnId(event);
    if (isCurrentTurnBoundaryEvent(event)) {
      active = null;
    } else if (turnId === null) {
      // Not a turn-scoped event; nothing to learn.
    } else if (event.type === "turn.started") {
      active = turnId;
      ended = null;
    } else if (TURN_END_TYPES.has(event.type)) {
      active = null;
      ended = turnId;
    } else if (active === null && turnId !== ended) {
      active = turnId;
    }
    remaining -= 1;
    if (remaining <= 0) {
      break;
    }
  }
  return active;
};

/**
 * Cancels the active Slack turn, if any, and logs one bounded ops line with
 * what eve answered. The notice is not posted here: eve's cancellation is
 * cooperative, so the turn ends at its next step boundary, and that is when
 * the channel's `turn.cancelled` handler posts it. A stop with no active
 * turn stays quiet. The path never rejects: dispatch is a Slack handler, and
 * a stream read or cancel request that fails is logged as `error` instead.
 */
export const cancelActiveSlackTurn = async (
  ctx: SlackInboundMessageContext
): Promise<void> => {
  let sessionId: string | null = null;
  let turnId: string | null = null;
  let outcome = "error";
  try {
    const session = await ctx.resolveSession();
    sessionId = session?.id ?? null;
    turnId = session ? await activeSlackTurn(session) : null;
    outcome =
      session && turnId
        ? (await session.cancel({ turnId })).status
        : "no_active_turn";
  } catch {
    // Logged below with outcome "error"; the stop is consumed either way.
  }
  logOpsEvent("slack.stop", { outcome, sessionId, turnId });
};

const stopNoticeId = (
  slack: SlackInboundMessageContext["slack"],
  turnId: string
): string => {
  // Preserve the original byte encoding across rolling deployments. Slack
  // deduplicates retries by this id, so adding a namespace or trailing
  // separator would allow an old and a new handler to post twice.
  const hex = createHash("sha256")
    .update(slack.teamId ?? "")
    .update("\0")
    .update(slack.channelId)
    .update("\0")
    .update(slack.threadTs)
    .update("\0")
    .update(turnId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const postNotice = async (
  slack: SlackInboundMessageContext["slack"],
  clientMessageId: string,
  text: string,
  failure: string
): Promise<void> => {
  try {
    const response = await slack.request("chat.postMessage", {
      channel: slack.channelId,
      client_msg_id: clientMessageId,
      text,
      thread_ts: slack.threadTs,
    });
    if (response.ok) {
      return;
    }
  } catch {
    // Eve catches an authored Slack handler rejection after acknowledging the
    // event and surfaces a thrown event handler as turn.failed, so throwing
    // cannot produce a useful retry; the warning is the whole signal.
  }
  console.warn(failure);
};

/**
 * Posts one provider-idempotent notice for an exact cancelled turn. The text
 * is true for every cancellation source, because the handler cannot tell a
 * literal stop from a reset or a session limit: in eve 0.44 dispatch has no
 * channel state to record the stop in, `turn.cancelled` carries only the
 * sequence and turn id, and `cancel` accepts only the turn id (see
 * EVE-PROPOSALS.md).
 */
export const postCancelledNotice = (
  ctx: { readonly slack: SlackInboundMessageContext["slack"] },
  turnId: string
): Promise<void> =>
  postNotice(
    ctx.slack,
    stopNoticeId(ctx.slack, turnId),
    "Cancelled. This request did not finish.",
    "Slack cancellation notice could not be posted."
  );

/**
 * Tells a mention that arrived while a turn was running that it is queued.
 * The queue turn policy delivers it after the active turn finishes; without
 * this line the requester sees nothing until then. Keyed by the message
 * timestamp, so a redelivered event cannot post the line twice.
 */
export const postQueuedNotice = (
  ctx: SlackInboundMessageContext,
  messageTs: string
): Promise<void> =>
  postNotice(
    ctx.slack,
    stableSlackClientMessageId(
      "queued",
      ctx.slack.teamId ?? "",
      ctx.slack.channelId,
      ctx.slack.threadTs,
      messageTs
    ),
    "Queued: I am still working on the earlier request in this thread and will answer this one when it finishes.",
    "Slack queued notice could not be posted."
  );
