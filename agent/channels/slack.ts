import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { SLACK_INTAKE_ONLY_CHANNELS } from "../lib/constants.js";
import { extractRepositories, stampRepository } from "../lib/repository.js";
import { stampIntakeOnly, stampTrusted } from "../lib/trust.js";

/**
 * Slack channel: mentions in, threaded progress out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the bot token
 * and verifies inbound webhooks by their Vercel OIDC signature. The app is
 * only invited into developer channels, so channel membership is the gate
 * here (the same shape as Linear, where workspace membership gates Agent
 * Sessions): every mention is stamped trusted at dispatch. Keep the app out
 * of open channels, or move trust to a per-user check before widening it.
 * Channels listed in SLACK_INTAKE_ONLY_CHANNELS are intake-only: their
 * mentions stay trusted, so conversation runs as normal, but the session is
 * stamped intake-only and intakeOnlyPolicy denies prepare_repository, so no
 * repository work can start there on either path. INTAKE_ONLY_TASK tells the
 * model to file the request as a Linear issue instead.
 */

// Task injected into a mention from an intake-only channel. The hard gate is
// intakeOnlyPolicy on prepare_repository, which denies repository work for
// these sessions; this text tells the model what to do with the denial.
const INTAKE_ONLY_TASK = [
  "This message came from a Slack channel that is intake-only: nobody there can action code changes directly, so treat it as a request to be routed, not as a work order to execute here.",
  "Do not do any repository work for anything said in this channel, on either path: no editing files, no branches, no pull requests, and no delegating a repository station. Repository preparation is denied for this session, so there is no way around this and no reason to try.",
  "If the message is a work item (a fix, a build, or a change request), create a Linear issue that captures it, leave it unassigned for triage, and tell the requester it has been filed and will be picked up from the tracker.",
  "Conversation is unaffected: answer questions, discuss the request, and follow up in the thread as normal.",
].join("\n\n");

export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  ),
  onAppMention: (ctx, message) => {
    const auth = defaultSlackAuth(message, ctx);
    if (auth === null) {
      return null;
    }
    const repositories = extractRepositories(message.text);
    const trusted = stampTrusted(auth);
    const [repository] = repositories;
    const stamped =
      repositories.length === 1 && repository
        ? stampRepository(trusted, repository.slug, "explicit")
        : trusted;
    return SLACK_INTAKE_ONLY_CHANNELS.has(message.channelId)
      ? { auth: stampIntakeOnly(stamped), context: [INTAKE_ONLY_TASK] }
      : { auth: stamped };
  },
  threadContext: { since: "last-agent-reply" },
});
