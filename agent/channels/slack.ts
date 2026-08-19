import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { SLACK_INTAKE_ONLY_CHANNELS } from "../lib/constants.js";
import { extractRepositories, stampRepository } from "../lib/repository.js";
import { stampTrusted } from "../lib/trust.js";

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
 * mentions stay trusted but get INTAKE_ONLY_TASK injected, so work items are
 * filed as Linear issues instead of running the pipeline.
 */

// Task injected into a mention from an intake-only channel: nobody there can
// action code changes, so work items are filed as Linear issues and routed
// through the pipeline from the tracker instead of being actioned here.
const INTAKE_ONLY_TASK = [
  "This message came from a Slack channel that is intake-only: nobody there can action code changes directly, so treat it as a request to be routed, not as a work order to execute here.",
  "Do not run the implementation pipeline for anything said in this channel. Do not call the classifier, analyst, implementer, or reviewer, and do not load the factory-pipeline skill.",
  "If the message is a work item (a fix, a build, or a change request), create a Linear issue that captures it and tell the requester it has been filed and will be picked up from the tracker.",
  "A conversational question can be answered directly.",
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
      ? { auth: stamped, context: [INTAKE_ONLY_TASK] }
      : { auth: stamped };
  },
  threadContext: { since: "last-agent-reply" },
});
