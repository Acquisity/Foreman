import { connectLinearCredentials } from "@vercel/connect/eve";
import type {
  LinearAgentSessionEvent,
  LinearInboundResult,
  LinearSessionContext,
} from "eve/channels/linear";
import {
  defaultLinearAuth,
  linearChannel,
  messageFromLinearAgentSessionEvent,
} from "eve/channels/linear";
import { isFactoryRequest, stampFactoryIntent } from "../lib/factory-lane.js";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { stampInvestigationMemory, stampTrusted } from "../lib/trust.js";

/**
 * Dispatches one Linear Agent Session event.
 *
 * @remarks
 * Exported so the dispatch itself is testable: what a Linear session may load
 * has to be asserted against the handler that actually runs, not against an
 * auth object assembled by hand.
 */
export const onAgentSession = (
  _ctx: LinearSessionContext,
  event: LinearAgentSessionEvent
): LinearInboundResult => {
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
  const auth = stampInvestigationMemory(stampTrusted(defaultLinearAuth(event)));
  const [repository] = repositories;
  const withRepository =
    repositories.length === 1 && repository
      ? stampRepository(auth, repository.slug, "explicit")
      : auth;
  // An Agent Session is an interactive lane, so it can ask for the factory the
  // same way Slack does. The dispatch is the only place that sees the delivered
  // text, because a dynamic skill resolver runs at turn.started with an empty
  // message snapshot, and a Linear issue often names no GitHub URL at all.
  return {
    auth: isFactoryRequest(messageFromLinearAgentSessionEvent(event))
      ? stampFactoryIntent(withRepository)
      : withRepository,
    context,
  };
};

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
  onAgentSession,
});
