import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  type SlackInboundMessageContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { SLACK_INTAKE_ONLY_CHANNELS } from "../lib/constants.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { stampIntakeOnly, stampTrusted } from "../lib/trust.js";

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
 * on the direct path and inside the stations alike. INTAKE_ONLY_TASK tells
 * the model to file the change as a Linear issue instead.
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

// Task injected into a mention from an intake-only channel. The hard gate is
// intakeOnlyPolicy on the push tools, which denies delivery for these
// sessions; this text tells the model what to do instead.
const INTAKE_ONLY_TASK = [
  "This message came from a Slack channel that is intake-only: nobody there can authorize shipping code, so treat it as a request to be routed, not as a work order to execute here.",
  "Answer questions and investigate as deeply as the thread needs, reading the repository included. Do not deliver a change: no pushed branch and no pull request, on either path. Pushing is denied for this session, so there is no way around it and no reason to try.",
  "If the message is a work item (a fix, a build, or a change request), create a Linear issue that captures it along with anything you found, leave it unassigned for triage, and tell the requester it has been filed and will be picked up from the tracker.",
].join("\n\n");

const dispatch = (ctx: SlackInboundMessageContext, message: SlackMessage) => {
  const auth = defaultSlackAuth(message, ctx);
  if (auth === null) {
    return null;
  }
  const repositories = extractRepositoryUrls(message.text);
  const trusted = stampTrusted(auth);
  const [repository] = repositories;
  const stamped =
    repositories.length === 1 && repository
      ? stampRepository(trusted, repository.slug, "explicit")
      : trusted;
  return SLACK_INTAKE_ONLY_CHANNELS.has(message.channelId)
    ? { auth: stampIntakeOnly(stamped), context: [INTAKE_ONLY_TASK] }
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
