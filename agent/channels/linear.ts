import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositories, stampRepository } from "../lib/repository.js";
import { stampTrusted } from "../lib/trust.js";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * `onAgentSession` hook keeps the default created/prompted dispatch, stamps
 * the caller as trusted (only workspace members can open an Agent Session, so
 * membership is the gate here), and builds the session context through
 * `buildLinearContext` (agent/lib/linear-context.ts): the requester's
 * name for attribution, plus the factory intake task when an issue is
 * delegated on a `created` event. `prompted` continuations in the same session
 * do not re-inject the task.
 */
export default linearChannel({
  credentials: connectLinearCredentials(
    process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"
  ),
  onAgentSession: (_ctx, event) => {
    const context = buildLinearContext(event);
    if (context === null) {
      return null;
    }
    const repositories = extractRepositories(
      JSON.stringify(event.agentSession.issue ?? {})
    );
    const auth = stampTrusted(defaultLinearAuth(event));
    const [repository] = repositories;
    return {
      auth:
        repositories.length === 1 && repository
          ? stampRepository(auth, repository.slug, "explicit")
          : auth,
      context,
    };
  },
});
