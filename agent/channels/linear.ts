import { connectLinearCredentials } from "@vercel/connect/eve";
import type {
  LinearAgentSessionEvent,
  LinearChannel,
  LinearInboundResult,
  LinearSessionContext,
} from "eve/channels/linear";
import {
  createLinearAgentActivity,
  defaultLinearAuth,
  linearChannel,
  linearContinuationToken,
  parseLinearWebhookEvent,
} from "eve/channels/linear";
import type { FollowUpOutcome } from "../lib/jev-decisions.js";
import { buildLinearContext } from "../lib/linear-context.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
import { readAskFrom, relayedFollowUpOutcome } from "../lib/requester-reply.js";
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
 * Runs a pre-model read inside Linear's response window. Any failure or a
 * slow answer yields null, so the session dispatches as usual: a throw here
 * would drop it.
 */
const withinGate = async <T>(
  work: (signal: AbortSignal) => Promise<T | null>
): Promise<T | null> => {
  const deadline = AbortSignal.timeout(FOLLOW_UP_GATE_MS);
  const timedOut = new Promise<null>((resolve) =>
    deadline.addEventListener("abort", () => resolve(null), { once: true })
  );
  try {
    return await Promise.race([work(deadline), timedOut]);
  } catch {
    return null;
  }
};

const issueOf = (event: LinearAgentSessionEvent): string | undefined =>
  event.agentSession.issueId ?? event.agentSession.issue?.id ?? undefined;

/** Judges a relayed Slack follow-up before the model runs. */
const followUpOutcome = (
  event: LinearAgentSessionEvent
): Promise<FollowUpOutcome | null> => {
  // A reply either opened its own session (legacy relay with a mention) or
  // was prompted into the ticket's existing one by the receiver.
  const prompted = event.action === "prompted";
  const commentId = prompted
    ? event.agentActivity?.sourceCommentId
    : event.action === "created" && event.agentSession.commentId;
  const issue = issueOf(event);
  if (!(issue && commentId)) {
    return Promise.resolve(null);
  }
  return withinGate((signal) =>
    relayedFollowUpOutcome(issue, { commentId, prompted }, credentials, signal)
  );
};

/** Names the intake requester before the model runs (ENG-14588). */
const askFrom = (event: LinearAgentSessionEvent): Promise<string | null> => {
  const issue = issueOf(event);
  return issue
    ? withinGate(() => readAskFrom(issue, credentials))
    : Promise.resolve(null);
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
  // The Stop button is handled by the route (see withLinearStop), never the
  // model.
  if (
    (event.action !== "created" && event.action !== "prompted") ||
    isStopSignal(event)
  ) {
    return null;
  }
  // Every relayed Slack reply opens a session; one that needs nothing from
  // Foreman ends here with a line in the session chat, never on the ticket.
  // If the line cannot be posted, dispatch rather than leave the session
  // with nothing.
  const [outcome, requester] = await Promise.all([
    followUpOutcome(event),
    askFrom(event),
  ]);
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
  const context = buildLinearContext(event, requester) ?? [];
  return {
    auth: withRepository,
    context:
      outcome === "status" ? [...context, STATUS_ONLY_FOLLOW_UP] : context,
  };
};

/** Whether a Linear event is the session's Stop button (ENG-14608). */
export const isStopSignal = (event: LinearAgentSessionEvent): boolean =>
  event.action === "prompted" && event.agentActivity?.signal === "stop";

/**
 * Retires the session a Linear Stop targets and confirms it in the session.
 *
 * @remarks
 * eve's Linear channel delivers Stop as an ordinary prompt, which the queue
 * policy holds until the running turn ends. The route therefore resets the
 * exact session, as Slack's literal stop does: a reset, unlike a cancel, also
 * keeps later child results from waking the root. The next prompt in the same
 * Linear session starts a fresh eve session with the ticket context.
 */
export const withLinearStop = (
  channel: LinearChannel,
  post: typeof createLinearAgentActivity = createLinearAgentActivity
): LinearChannel => ({
  ...channel,
  routes: channel.routes.map((route) =>
    route.transport === "websocket"
      ? route
      : {
          ...route,
          handler: async (request, args) => {
            const body = request.clone().text();
            const response = await route.handler(request, args);
            // Only a verified delivery is acknowledged with 200.
            if (!response.ok) {
              return response;
            }
            // eve acknowledges an unparseable body as ignored; so does this.
            let event: ReturnType<typeof parseLinearWebhookEvent>;
            try {
              event = parseLinearWebhookEvent({
                body: await body,
                headers: request.headers,
              });
            } catch {
              return response;
            }
            if (event?.kind === "agent_session" && isStopSignal(event)) {
              const agentSessionId = event.agentSession.id;
              args.waitUntil(
                args
                  .from(linearContinuationToken(agentSessionId))
                  .reset({ reason: "Linear stop requested." })
                  .then((result) =>
                    post({
                      activity: {
                        agentSessionId,
                        content: {
                          body:
                            result.status === "reset"
                              ? "Stopped."
                              : "Nothing was running.",
                          type: "response",
                        },
                      },
                      credentials,
                    })
                  )
                  .catch(() => console.warn("Linear stop could not complete."))
              );
            }
            return response;
          },
        }
  ),
});

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Vercel Connect supplies the app token and verifies inbound webhooks by their
 * Vercel OIDC signature. Only workspace members can open an Agent Session, so
 * workspace membership is the gate behind {@link stampTrusted}.
 */
export default withLinearStop(
  linearChannel({
    credentials,
    onAgentSession,
    // One session per intake ticket: Slack replies are prompted into it, so a
    // burst waits for the running turn and folds into the next one instead of
    // cancelling an investigation. Stop is intercepted by withLinearStop.
    turnPolicy: "queue",
  })
);
