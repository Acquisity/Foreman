import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
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
 * Those channels also never show a sign-in prompt: user-scoped connections
 * authorize through `userConnect`, which denies a missing grant instead of
 * posting a status line and parking the turn on a consent flow nobody in an
 * intake channel can complete.
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
 */

const dispatch = (ctx: SlackInboundMessageContext, message: SlackMessage) => {
  const auth = defaultSlackAuth(message, ctx);
  if (auth === null) {
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

export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  ),
  onAppMention: dispatch,
  onDirectMessage: dispatch,
  threadContext: { since: "last-agent-reply" },
});
