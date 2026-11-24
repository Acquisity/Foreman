import { logOpsEvent } from "./ops-log.js";
import { BUG_REPORT_ADDED, BUG_REPORT_LOGGED } from "./widget-bug-report.js";
import { parseFindings } from "./widget-findings.js";
import type { WidgetDependencies } from "./widget-investigation.js";
import type { WidgetOutcome, WidgetRun } from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";
import type { fileTicketFor } from "./widget-ticket.js";
import type { TicketNote } from "./widget-ticket-followup.js";

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

/** Fixed wording after an answer whose filing failed, so the customer knows nothing was passed on. */
export const UNFILED_LINE =
  "I couldn't pass this to our team just now. Send your message again and I'll try once more.";

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

// A block from our own controls (the ownership guard, a gate outage) is not a
// finding that needs a person: the app tells the customer to send the message
// again. The reason itself can name an identifier, so only this flag crosses
// to the app.
export const RETRYABLE_BLOCK =
  /^(?:deadline$|gate_unavailable$|bug_report_unfiled$|(?:composed:)?(?:foreign_identifier|internal_artifact):)/u;

/**
 * Nobody takes a blocked chat over, so a block the customer cannot fix by
 * sending again files the conversation's ticket and says the team's answer
 * will come here. A teammate's run, a retryable block and a ticket that could
 * not be filed keep the block.
 */
export async function ticketInsteadOfBlock(
  run: Pick<WidgetRun, "id" | "question" | "scope">,
  result: WidgetOutcome,
  findings: unknown,
  ids: { runId: string; sessionId?: string },
  signal: AbortSignal | undefined,
  file: typeof fileTicketFor | undefined
): Promise<{ findings: unknown; result: WidgetOutcome }> {
  const reason = result.reason ?? "blocked";
  if (
    result.decision !== "block" ||
    // An overdue investigation would likely run out of time again on a resend.
    (reason !== "deadline" && RETRYABLE_BLOCK.test(reason))
  ) {
    return { findings, result };
  }
  const found = parseFindings(findings);
  const filed = await handoffTicket(
    run.scope,
    {
      summary: [
        `The customer wrote: ${run.question}`,
        `Foreman could not answer it (${reason}).`,
        ...(found
          ? [
              `What Foreman found: ${found.report}`,
              `Recommendation: ${found.recommendation}`,
            ]
          : []),
      ].join("\n\n"),
      title: `Support chat: ${found?.report ?? run.question}`,
    },
    ids,
    signal,
    file
  );
  if (!filed) {
    return { findings, result };
  }
  const ticket =
    "identifier" in filed ? { id: filed.identifier, url: filed.url } : null;
  return {
    findings: parseFindings({
      confidence: found?.confidence ?? "low",
      facts: found?.facts ?? [],
      needsHuman: false,
      recommendation: ANSWER_HERE,
      report: (
        found?.report ??
        `Foreman could not answer this (${reason}) and filed the conversation's ticket.`
      ).slice(0, 1000),
      ...(ticket ? { ticket } : {}),
    }),
    result: {
      citations: [],
      decision: "allow",
      message: ANSWER_HERE,
      reason: `${TICKET_INSTEAD} ${reason}`,
      status: "completed",
    },
  };
}

/** The whole reply to an ask for a person that states no need: an invitation, no ticket. */
export const completeInvite = (
  run: Pick<WidgetRun, "id">,
  scope: WidgetContext,
  deps: Pick<WidgetDependencies, "complete">
) =>
  deps.complete(
    run.id,
    {
      citations: [],
      decision: "allow",
      message: personInvite({
        conversationId: scope.conversationId,
        runId: run.id,
      }),
      reason: PERSON_INVITE,
      status: "completed",
    },
    null,
    run.id
  );

/**
 * Why a front-door turn files the conversation's ticket: the customer asked
 * for a person, or a member or client (who cannot start an investigation)
 * needs one, through the magnifying glass, a bug report, a refund or a ticket.
 */
export type FrontDoorTicket = "person" | "member";

/** The front-door ticket's summary and title for the team. */
export const frontDoorTicket = (
  why: FrontDoorTicket,
  scope: WidgetContext,
  latest: string,
  reply: string
) =>
  why === "person"
    ? {
        summary: `The customer asked for a person and wrote: ${latest}\n\nForeman's reply: ${reply}`,
        title: "Support chat: the customer asked for a person",
      }
    : {
        summary: `The customer, a workspace ${scope.role}, needs their workspace looked into, which only an owner or admin can start, and wrote: ${latest}\n\nForeman's reply: ${reply}`,
        title: `Support chat: a ${scope.role} needs their workspace looked into`,
      };

/**
 * The investigator's note for a toggled ask for a person whose ticket could
 * not be filed yet: it hands off, so the finish files the ticket.
 */
export const UNFILED_PERSON_NOTE =
  "\n\nThe customer asked for a person. Nobody takes over this chat, and the conversation's ticket could not be filed yet: set needsHuman true, and the app files it for the team when you finish. Answer the rest of the question as usual.";

/**
 * Replies that tell the customer their conversation has a ticket, including
 * the after-hours pickup line filed conversations got before ENG-20301.
 */
const FILED_REPLIES = [
  ANSWER_HERE,
  BUG_REPORT_LOGGED,
  BUG_REPORT_ADDED,
  "a teammate will pick this up",
];

/**
 * A follow-up reads the conversation's ticket when it was filed: an earlier
 * reply in the history says so, or, for a filing older than the history the
 * app sends, Foreman's own runs record it (a fast local read). An
 * investigation reads it regardless, since it waits on slower work anyway.
 * A conversation never filed waits on no Linear read.
 */
export const followUpNote = async (
  input: {
    history?: { role: "customer" | "assistant"; text: string }[];
    mode?: string;
    staff?: boolean;
  },
  scope: WidgetContext,
  signal: AbortSignal,
  deps: Pick<WidgetDependencies, "ticketNote" | "wasFiled">
): Promise<TicketNote | null> => {
  const investigating = input.mode === "investigate";
  if (
    input.staff ||
    !deps.ticketNote ||
    !(investigating || input.history?.length)
  ) {
    return null;
  }
  const filed =
    investigating ||
    input.history?.some(
      (turn) =>
        turn.role === "assistant" &&
        FILED_REPLIES.some((line) => turn.text.includes(line))
    ) ||
    (await (deps.wasFiled?.(scope, signal) ?? Promise.resolve(false)).catch(
      () => false
    ));
  return filed ? await deps.ticketNote(scope, signal) : null;
};

/** The investigator's copy of the ticket note, marked as the app's. */
export const investigatorNote = (note: TicketNote | null) =>
  note
    ? `\n\nNOTE FROM THE APP, not written by the customer: ${note.forInvestigator}`
    : "";
