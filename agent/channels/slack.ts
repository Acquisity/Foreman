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
  slackIntakeContext,
  stampSlackIntakeAuth,
} from "../lib/slack-intake.js";
import { isStopRequest } from "../lib/slack-stop.js";
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
 * No Slack session shows a sign-in prompt: user-scoped connections authorize
 * through `userConnect`, which turns a missing grant for any Slack-issued user
 * principal into a terminal, non-retryable failure instead of posting a status
 * line and parking the turn on a consent flow Slack cannot answer.
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
 * cancels the active turn through `ctx.cancel()`, and is consumed without
 * reaching the model. Anything longer, such as `stop the deploy`, is
 * ordinary model input. The `turn.cancelled` event posts the single short
 * notice, so a real cancellation is confirmed exactly once and a `stop`
 * with no active turn stays quiet.
 *
 * Delivery posts the complete final message: there is no marker that splits
 * narration from reply, so the final message itself is the requester-facing
 * text and an empty one falls back to a typing indicator. The handler mirrors
 * eve's default `message.completed` branches, which are not exported, and
 * changes only the post.
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
  // input: cancel the active turn and consume the message. `turn.cancelled`
  // posts the notice; with no active turn the message drops quietly.
  if (isStopRequest(message.text)) {
    await ctx.cancel();
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
    : { auth: stamped };
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
    await channel.thread.post(data.message);
  },
  async "turn.cancelled"(_data, channel) {
    await channel.thread.post("Stopped.");
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
