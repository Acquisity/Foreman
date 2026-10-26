import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  defineSlackRenderer,
  type SlackEvent,
  type SlackEventContext,
  type SlackInboundEventContext,
  type SlackInboundMessageContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { defineState } from "eve/context";
import { SLACK_INTAKE_ONLY_CHANNELS } from "../lib/constants.js";
import { extractRepositoryUrls } from "../lib/repository.js";
import { slackSessionAuth } from "../lib/session-auth.js";
import { slackFreshSessionHistory } from "../lib/slack-history.js";
import {
  admitsSlackMention,
  FINAL_SLACK_POST_RULE,
  QUESTIONS_ONLY_CHANNELS,
  RECEIVER_ONLY_CHANNELS,
  slackAttachmentContext,
  slackIntakeContext,
} from "../lib/slack-intake.js";
import { stableSlackClientMessageId } from "../lib/slack-message-id.js";
import { postSlackReply } from "../lib/slack-post.js";
import {
  decideSlackProgressLine,
  slackProgressActionLabel,
  slackProgressActionRequestLabel,
} from "../lib/slack-progress.js";
import {
  lookupSlackRequester,
  slackRequesterContext,
} from "../lib/slack-requester.js";
import {
  isStopRequest,
  postStopConfirmation,
  stopSlackSession,
} from "../lib/slack-stop.js";
import {
  alertDisputeId,
  isStripeDisputeAlert,
  renderStripeDisputeAlert,
  STRIPE_DISPUTES_CHANNEL,
  stripeDisputeSessionAuth,
  stripeDisputeSessionMessage,
} from "../lib/stripe-dispute-trigger.js";
import {
  isIntakeOnly,
  stampStripeDisputeId,
  stampTriageIntake,
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
 * on the direct path and inside delegated tasks alike. The channel mapping tells
 * the model which intake workflow and skills to use.
 *
 * Automatic Slack connection attempts never show a sign-in prompt: user-scoped
 * connections authorize through `userConnect`, which turns a missing grant for
 * any Slack-issued user principal into a terminal, non-retryable failure.
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
 * retires the entire session through its exact handle, and is consumed without
 * reaching the model. Reset finalizes background tasks so their cancellation
 * results cannot restart the root. The next message starts a fresh internal
 * session with visible Slack history; hidden state and sandbox files are lost.
 * Anything longer, such as `stop the deploy`, remains ordinary model input.
 * One acknowledgement follows a successful reset; a missing session stays
 * quiet. Child settlement still needs independent verification.
 *
 * Rendering is one renderer over eve's defaults. eve renders the
 * `Thinking...` status, reasoning, tool narration, and the task card;
 * Foreman's handlers call `next()` to keep that and add progress lines, its
 * failure text, chunked replies, and quiet intake-only threads, which get no
 * `received` status and no task card.
 *
 * A turn still running at 5 and 15 minutes posts one short progress line at
 * each threshold and never a third. `turn.started` seeds the per-turn
 * progress state, skipping intake-only sessions entirely so those threads
 * receive the final answer and no intermediate lines. `reasoning.appended`,
 * `actions.requested`, and `action.result` are the checkpoints: they count
 * finished calls, record what the turn is waiting on, and post the line
 * `slack-progress.ts` says is due. The final `message.completed` branch,
 * `turn.completed`, `turn.cancelled`, and `turn.failed` clear the state without
 * checking, preventing a late progress checkpoint from posting beside the
 * final reply. eve emits no event during a single uninterrupted tool
 * execution and offers authored channel code no durable wakeup, so a line
 * that comes due mid-action posts at the next lifecycle event.
 *
 * Slack rejects a markdown post over 12,000 characters, so final replies go
 * through `slack-post.ts`: ordered chunks that prefer paragraph then line
 * boundaries, plus one short visible fallback naming the Slack error when a
 * post is rejected. A non-terminal turn failure posts Foreman's short text
 * with the error id; Foreman's `session.failed` notice owns terminal failures
 * so the thread sees one content-free message.
 *
 * Stripe dispute alerts (ENG-16255) arrive through `onEvent`: Acquisity posts
 * them through this same Slack app, so eve drops them from every message hook
 * as self-authored. A matching alert starts one unattended session in its
 * thread. A person mentioning Foreman in an alert thread gets the alert read
 * back from the thread root, because `last-agent-reply` thread context starts
 * after this app's last message and the alert is this app's message.
 */

/** How long dispatch waits for the alert thread's root message. */
const ALERT_ROOT_TIMEOUT_MS = 5000;

/**
 * The alert this mention's thread hangs off, as one context line, when the
 * mention is a reply in a disputes-channel alert thread. Any other channel or
 * a top-level mention adds nothing and makes no call. A failed or slow read
 * adds nothing either; the skill then asks for the dispute id.
 *
 * @remarks
 * The root comes from eve's own thread refresh, the first page of 50 replies
 * that history restoration shares, because its `isMe` flag is the only proof
 * available here that this app posted the root: the mention's payload carries
 * no app id to compare with.
 */
export const stripeDisputeAlertContext = async (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
): Promise<{ context: string; disputeId?: string } | undefined> => {
  if (
    message.channelId !== STRIPE_DISPUTES_CHANNEL ||
    message.threadTs === message.ts
  ) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const loaded = await Promise.race([
      ctx.thread.refresh().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ALERT_ROOT_TIMEOUT_MS);
      }),
    ]);
    const root = loaded
      ? ctx.thread.recentMessages.find(
          (entry) => entry.ts === message.threadTs && entry.isMe
        )
      : undefined;
    if (
      root &&
      isStripeDisputeAlert(message.channelId, root.raw, root.raw.app_id)
    ) {
      return {
        context: `This thread is a Stripe dispute alert. Load the stripe-disputes skill. The alert:\n${renderStripeDisputeAlert(root.raw)}`,
        disputeId: alertDisputeId(root.raw),
      };
    }
  } catch (error) {
    console.error("Stripe dispute alert root read failed.", error);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Starts one unattended session for a new Stripe dispute alert. Every other
 * event, from every other channel, returns at the matcher's first check.
 */
export const onStripeDisputeEvent = async (
  ctx: SlackInboundEventContext,
  event: SlackEvent
): Promise<void> => {
  if (!isStripeDisputeAlert(event.channel, event, ctx.envelope.api_app_id)) {
    return;
  }
  const threadTs = String(event.ts);
  const target = { channelId: STRIPE_DISPUTES_CHANNEL, threadTs };
  // eve dedupes event ids per instance only. A session already in the thread
  // means another delivery of this alert got there first; the tool's dispute
  // re-check covers whatever slips past this.
  try {
    if (await ctx.resolveSession({ target })) {
      return;
    }
  } catch (error) {
    console.error("Stripe dispute session lookup failed.", error);
  }
  await ctx.send(stripeDisputeSessionMessage(renderStripeDisputeAlert(event)), {
    auth: stripeDisputeSessionAuth({
      disputeId: alertDisputeId(event),
      teamId:
        typeof ctx.envelope.team_id === "string"
          ? ctx.envelope.team_id
          : undefined,
      threadTs,
    }),
    target,
    title: "Stripe dispute",
  });
};

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
  if (!admitsSlackMention(message.channelId, message.author)) {
    return null;
  }
  // A literal stop/cancel retires the exact session, never reaching the model.
  // Do not cancel first: a cancelled task can wake the root before reset.
  if (isStopRequest(message.text)) {
    const stoppedSessionId = await stopSlackSession(ctx);
    if (stoppedSessionId) {
      await postStopConfirmation(ctx, stoppedSessionId);
    }
    return null;
  }
  const repositories = extractRepositoryUrls(message.text);
  const [repository] = repositories;
  // Restricting investigation memory to the routed intake channels was tighter
  // than the design asked for and left developer channels silently without
  // history, which reads as memory being broken rather than being off, so
  // slackSessionAuth stamps it for every admitted Slack session.
  // Questions-only channels are always intake-only too, whatever the
  // environment list says, so a missing env entry cannot open delivery there.
  const questionsOnly = QUESTIONS_ONLY_CHANNELS.has(message.channelId);
  const intakeOnly =
    questionsOnly || SLACK_INTAKE_ONLY_CHANNELS.has(message.channelId);
  const sessionAuth = slackSessionAuth(auth, {
    intakeOnly,
    questionsOnly,
    repository:
      repositories.length === 1 && repository ? repository.slug : undefined,
  });
  // The receiver's mention in a triage intake channel runs on the triage
  // models (ENG-15226); admitsSlackMention already kept everyone else out.
  const stamped = RECEIVER_ONLY_CHANNELS.has(message.channelId)
    ? stampTriageIntake(sessionAuth)
    : sessionAuth;
  // One line naming any attached files, because eve stages them in the
  // sandbox without telling the text-only chat model that they exist. Only
  // the triggering message is read here: eve's own thread lookback, which
  // stages a file dropped earlier in the thread, is not visible to dispatch.
  const attachmentContext = slackAttachmentContext(message.attachments);
  const history = await slackFreshSessionHistory(ctx, message);
  const disputeAlert = await stripeDisputeAlertContext(ctx, message);
  // Who is asking, from the signed author id's Slack profile, never the text.
  const requesterContext = questionsOnly
    ? slackRequesterContext(await lookupSlackRequester(message.author?.userId))
    : undefined;
  const context = [
    intakeOnly ? slackIntakeContext(message.channelId) : FINAL_SLACK_POST_RULE,
    ...(requesterContext ? [requesterContext] : []),
    ...(attachmentContext ? [attachmentContext] : []),
    ...(disputeAlert ? [disputeAlert.context] : []),
    ...(history ? [history] : []),
  ];
  // The only dispute this turn may write is the one its thread's alert names.
  return {
    auth: disputeAlert?.disputeId
      ? stampStripeDisputeId(stamped, disputeAlert.disputeId)
      : stamped,
    context,
  };
};

// --- Slack rendering through one renderer over eve's defaults ---------------
// Every handler wraps eve's default renderer and calls next() unless it owns
// the event outright: final delivery and Foreman's failure text.

// Set by turn.started from the session auth and read by taskCard, which sees
// only the card view. Durable eve state, so it survives step boundaries.
const quietThread = defineState("foreman.slack.quiet", () => false);

const extractErrorId = (
  details: Record<string, unknown> | undefined
): string | undefined => {
  const id = details?.errorId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const slackFailureText = (
  nextStep: string,
  errorId: string | undefined
): string =>
  [
    "I hit an error while handling your request.",
    "",
    nextStep,
    ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
  ].join("\n");

// --- Progress checkpoint ----------------------------------------------------
// turn.started seeds the state (never for intake-only sessions),
// reasoning.appended, actions.requested, and action.result run this check,
// and the final message.completed, turn.completed, turn.cancelled, and
// turn.failed tear the state down. eve emits no event during a single
// uninterrupted tool execution and exposes no durable per-turn wakeup to
// authored channel code (the durable sleep tool is model-invoked; schedules
// are static cron with no access to another session's state), so a line that
// comes due mid-action posts at the next lifecycle event. Thresholds are
// indexed by posted-line count, so the extra checkpoints can never produce a
// third line.
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
  // logical identity is this turn's threshold, not the rendered text: if
  // bookkeeping changes before a retry, Slack may retain the first accepted
  // text so that one visible threshold line takes priority over freshness.
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

export const foremanRenderer = defineSlackRenderer({
  events: {
    async "action.result"(data, channel, _ctx, next) {
      // Progress bookkeeping: count the finished call, refresh the wait
      // label, then run the shared checkpoint. The line promises "tool
      // calls", so only a tool-result increments the count; subagent and
      // skill results still refresh the wait label.
      const { progress } = channel.state;
      if (progress) {
        channel.state.progress = {
          ...progress,
          toolCalls:
            data.result.kind === "tool-result"
              ? progress.toolCalls + 1
              : progress.toolCalls,
          waitLabel: slackProgressActionLabel(data.result),
        };
        await checkSlackProgress(channel, data.turnId);
      }
      await next();
    },
    async "actions.requested"(data, channel, _ctx, next) {
      const { progress } = channel.state;
      if (progress) {
        channel.state.progress = {
          ...progress,
          waitLabel: slackProgressActionRequestLabel(data.actions),
        };
      }
      await checkSlackProgress(channel, data.turnId);
      await next();
    },
    async "message.completed"(data, channel, _ctx, next) {
      // Narration before a tool call and an empty delivery stay with eve,
      // which buffers the narration or clears the thread status.
      if (data.finishReason === "tool-calls") {
        return next();
      }
      // The final message, even a silent one, ends progress tracking for the
      // turn, so no late checkpoint posts after it.
      channel.state.progress = undefined;
      if (!data.message?.trim()) {
        // eve's default clears the status and posts nothing for "".
        return next({ ...data, message: "" });
      }
      // This branch owns final delivery, so it never calls next(). The post
      // is verbatim: trimming would destroy leading Markdown indentation in
      // the reply. A throw here makes eve post its content-free "couldn't
      // deliver" notice.
      channel.state.pendingToolCallMessage = null;
      channel.state.threadStatus = null;
      await postSlackReply((chunk) => channel.thread.post(chunk), data.message);
    },
    async "reasoning.appended"(data, channel, _ctx, next) {
      await checkSlackProgress(channel, data.turnId);
      await next();
    },
    async "session.failed"(data, channel) {
      await channel.thread.post(
        slackFailureText(
          "Start a new thread to continue because I can't pick this one back up.",
          extractErrorId(data.details)
        )
      );
    },
    async "turn.cancelled"(_data, channel, _ctx, next) {
      // The explicit stop path owns its exact-turn acknowledgement. This
      // handler only tears down progress so unrelated cooperative
      // cancellations stay quiet and no late checkpoint can post beside the
      // stop notice.
      channel.state.progress = undefined;
      await next();
    },
    async "turn.completed"(_data, channel, _ctx, next) {
      channel.state.progress = undefined;
      await next();
    },
    async "turn.failed"(data, channel) {
      // A failed turn leaves no progress state behind. A terminal failure
      // posts nothing here, because Foreman's session.failed handler posts the
      // one terminal notice. Otherwise the thread gets a short outcome and
      // the error id only, in place of eve's default text; the raw error
      // name and message stay in operator records.
      channel.state.progress = undefined;
      if (data.terminal) {
        return;
      }
      await channel.thread.post(
        slackFailureText(
          "Please try again, rephrase, or reach out if it keeps failing.",
          extractErrorId(data.details)
        )
      );
    },
    async "turn.started"(_data, channel, ctx, next) {
      // Progress tracking starts here and only outside intake-only sessions:
      // those threads receive the final answer and no intermediate lines, so
      // they never carry progress state or a task card at all.
      const quiet = isIntakeOnly(ctx.session.auth.current);
      quietThread.update(() => quiet);
      channel.state.progress = quiet
        ? undefined
        : { posts: 0, startedAtMs: Date.now(), toolCalls: 0, waitLabel: null };
      await next();
    },
  },
  // Intake-only and questions-only channels get no Thinking... status.
  async received(message, _channel, next) {
    if (
      SLACK_INTAKE_ONLY_CHANNELS.has(message.channelId) ||
      QUESTIONS_ONLY_CHANNELS.has(message.channelId)
    ) {
      return;
    }
    await next();
  },
  taskCard: (view, next) => (quietThread.get() ? null : next(view)),
});

export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  ),
  onAppMention: dispatch,
  onDirectMessage: dispatch,
  onEvent: onStripeDisputeEvent,
  renderers: [foremanRenderer],
  threadContext: { since: "last-agent-reply" },
  turnPolicy: "queue",
});
