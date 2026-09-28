import { connectLinearCredentials } from "@vercel/connect/eve";
import type {
  LinearAgentSessionEvent,
  LinearInboundResult,
  LinearSessionContext,
} from "eve/channels/linear";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import type { FollowUpOutcome } from "../lib/jev-decisions.js";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { relayedFollowUpOutcome } from "../lib/requester-reply.js";
import { stampInvestigationMemory, stampTrusted } from "../lib/trust.js";

const credentials = connectLinearCredentials(
  process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"
);

/** Leaves time for the one-line response inside Linear's ten-second window. */
const FOLLOW_UP_GATE_MS = 7000;

/** Tells the model a follow-up only asks for a status move (ENG-14387). */
export const STATUS_ONLY_FOLLOW_UP =
  "Jev read this follow-up as only asking to move the ticket to a status. A person has already decided it: move the ticket to the state they named with route_ticket, send one confirming line with reply_to_requester, and end the session. Do not re-verify, call a decision tool, change the document, or run the critic. If their reply also asks a question or asks you to check something, handle it as a normal follow-up.";

/**
 * Judges a relayed Slack follow-up before the model runs. Any failure or a
 * slow answer dispatches the session as usual: a throw here would drop it.
 */
const followUpOutcome = async (
  event: LinearAgentSessionEvent
): Promise<FollowUpOutcome | null> => {
  // A reply either opened its own session (legacy relay with a mention) or
  // was prompted into the ticket's existing one by the receiver.
  const prompted = event.action === "prompted";
  const commentId = prompted
    ? event.agentActivity?.sourceCommentId
    : event.action === "created" && event.agentSession.commentId;
  const issue = event.agentSession.issueId ?? event.agentSession.issue?.id;
  if (!(issue && commentId)) {
    return null;
  }
  const deadline = AbortSignal.timeout(FOLLOW_UP_GATE_MS);
  const timedOut = new Promise<null>((resolve) =>
    deadline.addEventListener("abort", () => resolve(null), { once: true })
  );
  try {
    return await Promise.race([
      relayedFollowUpOutcome(
        issue,
        { commentId, prompted },
        credentials,
        deadline
      ),
      timedOut,
    ]);
  } catch {
    return null;
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
  // If the line cannot be posted, dispatch rather than leave the session
  // with nothing.
  const outcome = await followUpOutcome(event);
  if (
    outcome === "skip" &&
    (await ctx.linear
      .createActivity({ body: "No reply needed.", type: "response" })
      .then(
        () => true,
        () => false
      ))
  ) {
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
    context:
      outcome === "status" ? [...context, STATUS_ONLY_FOLLOW_UP] : context,
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
  // One session per intake ticket: Slack replies are prompted into it, so a
  // burst waits for the running turn and folds into the next one instead of
  // cancelling an investigation. Linear's Stop button still interrupts.
  turnPolicy: "queue",
});
