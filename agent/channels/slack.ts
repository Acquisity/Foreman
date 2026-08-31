import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  type SlackChannelEvents,
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
import { postSlackReply } from "../lib/slack-post.js";
import {
  cancelActiveSlackTurn,
  isStopRequest,
  postStopConfirmation,
} from "../lib/slack-stop.js";
import { stampInvestigationMemory, stampTrusted } from "../lib/trust.js";

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
 * Delivery posts the complete final message under the canonical rule injected
 * by dispatch: there is no marker that splits it, and an empty message falls
 * back to a typing indicator. Slack rejects a
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

export const slackChannelEvents: SlackChannelEvents = {
  async "message.completed"(data, channel) {
    if (data.finishReason === "tool-calls") {
      channel.state.pendingToolCallMessage = data.message
        ? (data.message.split("\n").find((line) => line.trim()) ?? null)
        : null;
      return;
    }
    channel.state.pendingToolCallMessage = null;
    // Blankness decides the typing fallback, but the post itself is verbatim:
    // trimming would destroy leading Markdown indentation in the reply.
    if (!data.message?.trim()) {
      await channel.thread.startTyping();
      return;
    }
    await postSlackReply((chunk) => channel.thread.post(chunk), data.message);
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
