import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositories, stampRepository } from "../lib/repository.js";
import { stampTrusted } from "../lib/trust.js";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
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
