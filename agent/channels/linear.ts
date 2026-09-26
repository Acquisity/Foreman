import { connectLinearCredentials } from "@vercel/connect/eve";
import type {
  LinearAgentSessionEvent,
  LinearInboundResult,
  LinearSessionContext,
} from "eve/channels/linear";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { followUpNeedsNothing } from "../lib/requester-reply.js";
import { stampInvestigationMemory, stampTrusted } from "../lib/trust.js";

const credentials = connectLinearCredentials(
  process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"
);

/** Leaves time for the one-line response inside Linear's ten-second window. */
const FOLLOW_UP_GATE_MS = 7000;

/**
 * Settles a relayed Slack follow-up before the model runs. Any failure or a
 * slow answer dispatches the session as usual: a throw here would drop it.
 */
const skipsFollowUp = async (event: LinearAgentSessionEvent) => {
  const { commentId } = event.agentSession;
  const issue = event.agentSession.issueId ?? event.agentSession.issue?.id;
  if (event.action !== "created" || !issue || !commentId) {
    return false;
  }
  const deadline = AbortSignal.timeout(FOLLOW_UP_GATE_MS);
  const timedOut = new Promise<false>((resolve) =>
    deadline.addEventListener("abort", () => resolve(false), { once: true })
  );
  try {
    return await Promise.race([
      followUpNeedsNothing(issue, commentId, credentials, deadline),
      timedOut,
    ]);
  } catch {
    return false;
  }
};

/**
 * Dispatches one Linear Agent Session event.
 *
 * @remarks
 * Exported so the dispatch itself is testable: what a Linear session may load
 * has to be asserted against the handler that actually runs, not against an
 * auth object assembled by hand.
 */
export const onAgentSession = async (
  ctx: LinearSessionContext,
  event: LinearAgentSessionEvent
): Promise<LinearInboundResult> => {
  const context = buildLinearContext(event);
  if (context === null) {
    return null;
  }
  // Every relayed Slack reply opens a session; one that needs nothing from
  // Foreman ends here with a line in the session chat, never on the ticket.
  if (await skipsFollowUp(event)) {
    await ctx.linear
      .createActivity({ body: "No reply needed.", type: "response" })
      .catch(() => undefined);
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
  return {
    auth: withRepository,
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
  credentials,
  onAgentSession,
});
