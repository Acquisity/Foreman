import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { stampInvestigationMemory, stampTrusted } from "../lib/trust.js";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Vercel Connect supplies the app token and verifies inbound webhooks by their
 * Vercel OIDC signature. Only workspace members can open an Agent Session, so
 * workspace membership is the gate behind {@link stampTrusted}.
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
    // URLs only: a bare `owner/repo` token in an issue title, description, or
    // comment is indistinguishable from a file path like `channels/github.ts`,
    // and stamping one binds the session to a repository that does not exist.
    const repositories = extractRepositoryUrls(
      JSON.stringify(event.agentSession.issue ?? {})
    );
    // Every Agent Session is opened by a workspace member, which is the same
    // gate triage itself runs behind, so Linear is an authorized investigation
    // memory surface.
    const auth = stampInvestigationMemory(
      stampTrusted(defaultLinearAuth(event))
    );
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
