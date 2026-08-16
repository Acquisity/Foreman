import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
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
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
  ),
  onAppMention: (ctx, message) => {
    const auth = defaultSlackAuth(message, ctx);
    return auth === null ? null : { auth: stampTrusted(auth) };
  },
  threadContext: { since: "last-agent-reply" },
});
