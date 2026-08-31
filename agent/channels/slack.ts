import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  describeActionRequests,
  type SlackChannelEvents,
  type SlackEventContext,
  type SlackInboundMessageContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { SLACK_INTAKE_ONLY_CHANNELS } from "../lib/constants.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import {
  FINAL_SLACK_POST_RULE,
  slackIntakeContext,
  stampSlackIntakeAuth,
} from "../lib/slack-intake.js";
import { stableSlackClientMessageId } from "../lib/slack-message-id.js";
import { postSlackReply } from "../lib/slack-post.js";
import {
  decideSlackProgressLine,
  slackProgressActionLabel,
  slackProgressActionRequestLabel,
} from "../lib/slack-progress.js";
import {
  cancelActiveSlackTurn,
  isStopRequest,
  postStopConfirmation,
} from "../lib/slack-stop.js";
import {
  isIntakeOnly,
  stampInvestigationMemory,
  stampTrusted,
} from "../lib/trust.js";

/**
 * Slack channel: mentions and direct messages in, threaded progress out, via
 * Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the bot token
 * and verifies inbound webhooks by their Vercel OIDC signature. The app is
 * only invited into developer channels, so channel membership is the gate
 * here (the same shape as Linear, where workspace membership gates Agent
 * Sessions): every mention is stamped trusted at dispatch. Keep the app out
 * of open channels, or move trust to a per-user check before widening it.
 * Channels listed in SLACK_INTAKE_ONLY_CHANNELS are intake-only: their
 * mentions stay trusted, so conversation and investigation run as normal, but
 * the session is stamped intake-only and intakeOnlyPolicy denies every push,
 * on the direct path and inside the stations alike. The channel mapping tells
 * the model which intake workflow and skills to use.
 *
 * Automatic Slack connection attempts never show a sign-in prompt: user-scoped
 * connections authorize through `userConnect`, which turns a missing grant for
 * any Slack-issued user principal into a terminal, non-retryable failure. The
 * attended root `sign_in` tool is the deliberate exception and may invoke
 * consent after a person explicitly asks to connect one service.
 *
 * Only a full GitHub URL in the message selects the session repository. A bare
 * `owner/repo` token is not extracted here, because prose cannot be told apart
 * from a slug: `channels/github.ts` parses as owner `channels`, repo
 * `github.ts`, and stamping it bound the session to a repository that does not
 * exist, after which nothing could be pushed. The model still reads the slug
 * out of the message and passes it to `prepare_repository`, which is the
 * selection path the prompt already describes.
 *
 * Mentions and direct messages run the same dispatch. eve only falls back to
 * its built-in handler for a surface this file leaves unauthored, and that
 * default stamps nothing: a DM dispatched through it carries no trust, no
 * repository selection, and no intake-only marker, so every delivery from a
 * DM parked on an approval card that Slack cannot deliver an answer to.
 *
 * Later mentions wait behind the running turn instead of replacing it: the
 * queue turn policy delivers a follow-up after the active turn finishes,
 * where the default steer policy cancelled the active turn and silently lost
 * the earlier request. One message still cancels on purpose: a text that is
 * only `stop` or `cancel` (see `slack-stop.ts`) is intercepted in dispatch,
 * cancels the active turn through its exact session handle, and is consumed
 * without
 * reaching the model. Anything longer, such as `stop the deploy`, is
 * ordinary model input. The stop path posts the single short notice only
 * after the exact turn emits its durable cancellation boundary, so unrelated
 * cooperative cancellations and no-op requests against parked sessions stay
 * quiet.
 *
 * A turn still running at 5 and 15 minutes posts one short progress line at
 * each threshold and never a third. `turn.started` seeds the per-turn
 * progress state, skipping intake-only sessions entirely so those threads
 * receive the final answer and no intermediate lines. `reasoning.appended`,
 * `actions.requested`, and `action.result` are the checkpoints: they count
 * finished calls, record what the turn is waiting on, and post the line
 * `slack-progress.ts` says is due. The final `message.completed` branch,
 * `turn.cancelled`, and `turn.failed` clear the state without checking, so
 * a progress line can never precede, follow, or duplicate the
 * requester-facing reply, and a failed turn leaves nothing behind. eve
 * emits no event during a single uninterrupted tool execution and offers
 * authored channel code no durable wakeup, so a line that comes due
 * mid-action posts at the next lifecycle event. The overridden events all
 * carry eve defaults that are not exported; each handler mirrors its
 * default exactly (the same pattern as `message.completed` below) and adds
 * only the progress behavior.
 *
 * Delivery sends each completed assistant response without a split marker;
 * an empty response falls back to a typing indicator. Slack rejects a
 * markdown post over 12,000 characters and eve swallows an event-handler
 * throw, so final replies go through `slack-post.ts`: ordered chunks that
 * prefer paragraph then line boundaries, plus one short visible fallback
 * naming the Slack error when a post is rejected. The handler mirrors eve's
 * default `message.completed` branches, which are not exported, and changes
 * only the post.
 */

export const dispatch = async (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
) => {
  // Admission comes first: an event the auth check would reject must never
  // cancel work either, so the stop command runs only for an admitted
  // author.
  const auth = defaultSlackAuth(message, ctx);
  if (auth === null) {
    return null;
  }
  // A literal stop/cancel is a command for the running turn, never model
  // input: cancel the exact active turn and consume the message. Confirming its
  // durable cancellation boundary ties the notice to this command instead of
  // another cooperative cancellation; with no active turn it drops quietly.
  if (isStopRequest(message.text)) {
    const cancelledTurnId = await cancelActiveSlackTurn(ctx);
    if (cancelledTurnId) {
      await postStopConfirmation(ctx, cancelledTurnId);
    }
    return null;
  }
  const repositories = extractRepositoryUrls(message.text);
  const trusted = stampTrusted(auth);
  const [repository] = repositories;
  const withRepository =
    repositories.length === 1 && repository
      ? stampRepository(trusted, repository.slug, "explicit")
      : trusted;
  // Investigation memory follows the same gate as trust here: the app is only
  // invited into Acquisity channels, so channel membership is the boundary.
  // Restricting it to the routed intake channels was tighter than the design
  // asked for and left developer channels silently without history, which
  // reads as memory being broken rather than being off.
  const stamped = stampInvestigationMemory(withRepository);
  return SLACK_INTAKE_ONLY_CHANNELS.has(message.channelId)
    ? {
        auth: stampSlackIntakeAuth(stamped),
        context: [slackIntakeContext(message.channelId)],
      }
    : { auth: stamped, context: [FINAL_SLACK_POST_RULE] };
};

// --- Mirrors of eve's unexported Slack default rendering -------------------
// Overriding an event replaces its default per-key, and the defaults for
// reasoning.appended, actions.requested, and turn.failed are not exported
// (they live in eve's channels/slack defaults module). Each helper below
// replicates one piece of that default rendering exactly, so the overrides
// add progress behavior without changing what the thread already saw. The
// action label is the exception: eve/channels/slack publicly exports
// describeActionRequests, so the actions.requested override calls the
// canonical helper instead of mirroring it.

const LINE_SPLIT_PATTERN = /\r?\n/u;

const firstNonEmptyLine = (text: string): string | undefined => {
  for (const raw of text.split(LINE_SPLIT_PATTERN)) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return undefined;
};

const truncateWithEllipsis = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

const stripTypingStatusMarkdown = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(
      /(^|[^\p{L}\p{N}])(\*\*|__)([^*_]+)\2(?=$|[^\p{L}\p{N}])/gu,
      "$1$3"
    )
    .replace(/(^|[^\p{L}\p{N}*])\*([^*_]+)\*(?=$|[^\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_([^*_]+)_(?=$|[^\p{L}\p{N}_])/gu, "$1$2");

const SLACK_TYPING_STATUS_MAX_LENGTH = 50;

const truncateTypingStatus = (text: string): string =>
  truncateWithEllipsis(
    stripTypingStatusMarkdown(text).trim().replace(/\s+/gu, " "),
    SLACK_TYPING_STATUS_MAX_LENGTH
  );

const ERROR_HINT_MAX_LENGTH = 160;

const truncateForDisplay = (text: string): string =>
  text.length <= ERROR_HINT_MAX_LENGTH
    ? text
    : `${text.slice(0, ERROR_HINT_MAX_LENGTH - 1).trimEnd()}…`;

const formatErrorHint = (data: {
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}): string => {
  const rawName = data.details?.name;
  const name =
    typeof rawName === "string" && rawName.length > 0 ? rawName : undefined;
  const message = data.message.trim();
  if (name && message.length > 0) {
    return ` (${name}: ${truncateForDisplay(message)})`;
  }
  if (name) {
    return ` (${name})`;
  }
  return message.length > 0 ? ` (${truncateForDisplay(message)})` : "";
};

const extractErrorId = (
  details: Record<string, unknown> | undefined
): string | undefined => {
  const id = details?.errorId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

// --- Progress checkpoint ----------------------------------------------------
// turn.started seeds the state (never for intake-only sessions),
// reasoning.appended, actions.requested, and action.result run this check,
// and the final message.completed, turn.cancelled, and turn.failed tear the
// state down. eve 0.44 emits no event during a single uninterrupted tool
// execution and exposes no durable per-turn wakeup to authored channel code
// (the durable sleep tool is model-invoked; schedules are static cron with
// no access to another session's state), so a line that comes due
// mid-action posts at the next lifecycle event. Thresholds are indexed by
// posted-line count, so the extra checkpoints can never produce a third
// line.
const checkSlackProgress = async (
  channel: SlackEventContext,
  turnId: string
): Promise<void> => {
  const { progress } = channel.state;
  if (!progress) {
    return;
  }
  const line = decideSlackProgressLine(progress, Date.now());
  if (!line) {
    return;
  }
  // A stable provider id keeps an ambiguous retry from creating a duplicate
  // if Slack accepted the first request but its response was lost. The
  // threshold is consumed only after Slack confirms the idempotent post. A
  // rejection stays unconsumed so the next checkpoint retries the same id.
  try {
    const response = await channel.slack.request("chat.postMessage", {
      channel: channel.slack.channelId,
      client_msg_id: stableSlackClientMessageId(
        "progress",
        channel.slack.teamId ?? "",
        channel.slack.channelId,
        channel.slack.threadTs,
        turnId,
        String(progress.posts)
      ),
      text: line,
      thread_ts: channel.slack.threadTs,
    });
    if (!response.ok) {
      throw new Error(
        `Slack chat.postMessage failed: ${String(response.error ?? "unknown_error")}`
      );
    }
  } catch (error) {
    console.error("Slack progress post failed.", error);
    return;
  }
  channel.state.progress = { ...progress, posts: progress.posts + 1 };
};

export const slackChannelEvents: SlackChannelEvents = {
  async "action.result"(data, channel) {
    // eve has no default handler for this event, so the override only adds
    // progress bookkeeping: count the finished call, refresh the wait label,
    // then run the shared checkpoint. The line promises "tool calls", so
    // only a tool-result increments the count; subagent and skill results
    // still refresh the wait label.
    const { progress } = channel.state;
    if (!progress) {
      return;
    }
    channel.state.progress = {
      ...progress,
      toolCalls:
        data.result.kind === "tool-result"
          ? progress.toolCalls + 1
          : progress.toolCalls,
      waitLabel: slackProgressActionLabel(data.result),
    };
    await checkSlackProgress(channel, data.turnId);
  },
  async "actions.requested"(data, channel) {
    // Mirrors eve's default actions.requested typing indicator: buffered
    // model narration wins over the derived action label.
    const narration = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    const { progress } = channel.state;
    if (progress) {
      channel.state.progress = {
        ...progress,
        waitLabel: slackProgressActionRequestLabel(data.actions),
      };
    }
    await channel.thread.startTyping(
      truncateTypingStatus(narration ?? describeActionRequests(data.actions))
    );
    await checkSlackProgress(channel, data.turnId);
  },
  async "message.completed"(data, channel) {
    if (data.finishReason === "tool-calls") {
      channel.state.pendingToolCallMessage = data.message
        ? (data.message.split("\n").find((line) => line.trim()) ?? null)
        : null;
      return;
    }
    channel.state.pendingToolCallMessage = null;
    // The final message ends progress tracking for the turn; the reply below
    // is the only thing the thread sees at completion.
    channel.state.progress = undefined;
    // Blankness decides the typing fallback, but the post itself is verbatim:
    // trimming would destroy leading Markdown indentation in the reply.
    if (!data.message?.trim()) {
      await channel.thread.startTyping();
      return;
    }
    await postSlackReply((chunk) => channel.thread.post(chunk), data.message);
  },
  async "reasoning.appended"(data, channel) {
    // Mirrors eve's default reasoning.appended typing indicator: substantial
    // progressive extensions post immediately, smaller deltas refresh at
    // most every five seconds.
    const firstLine = firstNonEmptyLine(data.reasoningSoFar);
    if (firstLine !== undefined) {
      const status = truncateTypingStatus(firstLine);
      const previous = channel.state.lastReasoningTypingStatus;
      const isExtension =
        previous !== null &&
        previous !== undefined &&
        status.startsWith(previous) &&
        status.length >= previous.length + 4;
      const nowMs = Date.now();
      const lastMs = channel.state.lastReasoningTypingAtMs;
      const throttled =
        !isExtension &&
        lastMs !== null &&
        lastMs !== undefined &&
        nowMs - lastMs >= 0 &&
        nowMs - lastMs < 5000;
      if (!throttled) {
        await channel.thread.startTyping(status);
        channel.state.lastReasoningTypingAtMs = nowMs;
        channel.state.lastReasoningTypingStatus = status;
      }
    }
    await checkSlackProgress(channel, data.turnId);
  },
  "turn.cancelled"(_data, channel) {
    // The explicit stop path owns its exact-turn confirmation. This handler
    // only tears down progress so unrelated cooperative cancellations stay
    // quiet and no late checkpoint can post beside the stop notice.
    channel.state.progress = undefined;
  },
  async "turn.failed"(data, channel) {
    // A failed turn leaves no progress state behind. Mirrors eve's default
    // turn.failed error post exactly.
    channel.state.progress = undefined;
    const errorId = extractErrorId(data.details);
    await channel.thread.post(
      [
        `I hit an error while handling your request${formatErrorHint(data)}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n")
    );
  },
  async "turn.started"(_data, channel, ctx) {
    // Mirrors eve's default turn.started, which is not exported: clear the
    // buffered narration and typing state, then show the Working indicator.
    channel.state.pendingToolCallMessage = null;
    channel.state.lastReasoningTypingAtMs = null;
    channel.state.lastReasoningTypingStatus = null;
    // Progress tracking starts here and only outside intake-only sessions:
    // those threads receive the final answer and no intermediate lines, so
    // they never carry progress state at all.
    if (isIntakeOnly(ctx.session.auth.current)) {
      channel.state.progress = undefined;
    } else {
      channel.state.progress = {
        posts: 0,
        startedAtMs: Date.now(),
        toolCalls: 0,
        waitLabel: null,
      };
    }
    await channel.thread.startTyping("Working...");
  },
};

export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  ),
  events: slackChannelEvents,
  onAppMention: dispatch,
  onDirectMessage: dispatch,
  threadContext: { since: "last-agent-reply" },
  turnPolicy: "queue",
});
