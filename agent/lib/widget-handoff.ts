import { logOpsEvent } from "./ops-log.js";
import type { WidgetContext } from "./widget-scope.js";
import type { fileTicketFor } from "./widget-ticket.js";

/**
 * Nobody takes a support chat over (ENG-20283, decision 5). Whatever would
 * have handed the chat to a person files the conversation's one ticket
 * instead, the team answers it, and the answer is posted back into this chat.
 */

/** The outcome reason, or its prefix, of a reply that filed the conversation's ticket in place of a handoff. */
export const TICKET_INSTEAD = "ticket_instead_of_handoff";

/** The outcome reason of an ask for a person that stated no need: no ticket, nothing to act on yet. */
export const PERSON_INVITE = "person_invite";

const TICKET_TIMEOUT_MS = 30_000;

/** Fixed wording, so no model promises a person, a time or anything beyond where the answer will arrive. */
export const ANSWER_HERE =
  "I've passed this to our team, and their answer will come here in this chat.";

/** A customer's own turn. A teammate's inbox run is team-only and never files. */
export const customerTurn = (scope: WidgetContext) => scope.source === "widget";

type Turns = { role: "customer" | "assistant"; text: string }[] | undefined;

/** A reply with the answer-comes-here line after it, once per conversation. */
export const withAnswerHere = (message: string, turns: Turns) =>
  turns?.some(
    (turn) => turn.role === "assistant" && turn.text.includes(ANSWER_HERE)
  )
    ? message
    : `${message}\n\n${ANSWER_HERE}`;

/**
 * The whole reply to an ask for a person that says nothing else. No ticket:
 * one is filed only once the customer describes something Foreman cannot settle.
 */
export const personInvite = (ids: {
  conversationId: string;
  runId: string;
}) => {
  logOpsEvent("widget.handoff.ticket", { ...ids, decision: "invite" });
  return "Tell me what you need help with and I'll try to sort it out now. Anything I can't, I'll pass to our team, and their answer will come here in this chat.";
};

type Filed = Exclude<
  Awaited<ReturnType<typeof fileTicketFor>>,
  { error: string }
>;

/**
 * File the conversation's one ticket in place of a handoff (an existing one is
 * reused, commented on and, when Done, reopened). Null when the turn is a
 * teammate's or the ticket could not be filed.
 */
export async function handoffTicket(
  scope: WidgetContext,
  ticket: { summary: string; title: string },
  ids: { runId: string; sessionId?: string },
  signal: AbortSignal | undefined,
  /** Absent, nothing is filed: only callers wired to Linear file. */
  file: typeof fileTicketFor | undefined
): Promise<Filed | null> {
  if (!(file && customerTurn(scope))) {
    return null;
  }
  const filed = await file(
    scope,
    {
      summary: ticket.summary.slice(0, 4000),
      title: ticket.title.slice(0, 160),
    },
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TICKET_TIMEOUT_MS)])
      : AbortSignal.timeout(TICKET_TIMEOUT_MS),
    ids.runId
  ).catch(() => ({ error: "unavailable" }));
  const ok = !("error" in filed);
  logOpsEvent("widget.handoff.ticket", {
    conversationId: scope.conversationId,
    decision: ok ? "ticket" : "unfiled",
    ...ids,
  });
  return ok ? filed : null;
}

/** The line that tells the customer where the answer will come, or null when nothing was filed. */
export const ticketInsteadOfHandoff = async (
  ...args: Parameters<typeof handoffTicket>
): Promise<string | null> =>
  (await handoffTicket(...args)) ? ANSWER_HERE : null;
