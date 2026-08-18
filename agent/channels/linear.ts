import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { FACTORY_REPO } from "../lib/constants.js";
import { stampTrusted } from "../lib/trust.js";

/**
 * Task injected when an issue is delegated to the agent in a Linear Agent
 * Session. Unlike the GitHub label intake, this run is attended: a person is
 * watching the Agent Session, so clarification goes back to them through the
 * session rather than posting and stopping.
 */
const LINEAR_INTAKE_TASK = [
  `This issue was delegated to you in a Linear Agent Session. Run it through the full factory pipeline now: ground the issue, then classifier, analyst, implementer, reviewer, and deliver a draft pull request on ${FACTORY_REPO}. Load the factory-pipeline skill and follow it end to end.`,
  "A person is watching this Agent Session, so when the classifier needs clarification, ask them and wait; report progress as you go.",
].join("\n\n");

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * `onAgentSession` hook keeps the default created/prompted dispatch, stamps
 * the caller as trusted (only workspace members can open an Agent Session, so
 * membership is the gate here), and adds the requester's name as session
 * context when Linear provides it, for attribution in progress notes and
 * reports. When an issue is delegated (a `created` event carrying an issue),
 * it also injects the factory intake task so the delegated issue runs the
 * full pipeline; `prompted` continuations in the same session do not re-inject
 * it.
 */
export default linearChannel({
  credentials: connectLinearCredentials(
    process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"
  ),
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    const requester = event.agentActivity?.user ?? event.agentSession.creator;
    const context: string[] = [];
    const requesterName = requester?.displayName ?? requester?.name;
    if (requesterName) {
      context.push(`The requesting user is ${requesterName}.`);
    }
    if (event.action === "created" && event.agentSession.issue !== null) {
      context.push(LINEAR_INTAKE_TASK);
    }
    return { auth: stampTrusted(defaultLinearAuth(event)), context };
  },
});
