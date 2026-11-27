import { z } from "zod";
import type { ProviderContext } from "./executor/dispatch.js";
import { logOpsEvent } from "./ops-log.js";
import {
  BUG_REPORT_ADDED,
  BUG_REPORT_LOGGED,
  draftHandoffTicket,
  fallbackHandoffDraft,
  HANDOFF_DRAFT_MS,
  type HandoffFacts,
  handoffReport,
  handoffTicketBody,
} from "./widget-bug-report.js";
import {
  blockedForCustomer,
  customerTurn,
  escalatesToFixy,
} from "./widget-escalation.js";
import {
  parseFindings,
  teamFindings,
  type WidgetFindings,
} from "./widget-findings.js";
import type { WidgetDependencies } from "./widget-investigation.js";
import { isLiveActive } from "./widget-live-policy.js";
import {
  assertWidgetRunOwner,
  readWidgetRun,
  recentWidgetTurns,
  type WidgetOutcome,
  type WidgetRun,
} from "./widget-run-store.js";
import { requireWidgetContext, type WidgetContext } from "./widget-scope.js";
import { type fileTicketFor, fileWidgetTicket } from "./widget-ticket.js";
import type { TicketNote } from "./widget-ticket-followup.js";

/**
 * Whatever would have handed the chat to a person hands it to Fixy when
 * escalation is on (ENG-21094, `widget-escalation.ts`), with no ticket for the
 * escalation. With it off, nobody takes a support chat over (ENG-20283,
 * decision 5): those turns file the conversation's one ticket instead, the
 * team answers it, and the answer is posted back into this chat.
 */

/** The outcome reason, or its prefix, of a reply that filed the conversation's ticket in place of a handoff. */
export const TICKET_INSTEAD = "ticket_instead_of_handoff";

/** The outcome reason of an ask for a person that stated no need: no ticket, nothing to act on yet. */
export const PERSON_INVITE = "person_invite";

const TICKET_TIMEOUT_MS = 30_000;
const RECEIPT_READ_MS = 5000;
/**
 * Left for the filing itself when the caller has a deadline, its own reads
 * and write at their bounds (refund 3s, search 15s, write 15s): the ticket
 * matters more than its wording, so a draft runs only with this to spare.
 */
const FILING_ROOM_MS = 35_000;

/** Fixed wording, so no model promises a person, a time or anything beyond where the answer will arrive. */
export const ANSWER_HERE =
  "I've passed this to our team, and their answer will come here in this chat.";

/** Fixed wording after an answer whose filing failed, so the customer knows nothing was passed on. */
export const UNFILED_LINE =
  "I couldn't pass this to our team just now. Send your message again and I'll try once more.";

type Turns = { role: "customer" | "assistant"; text: string }[] | undefined;

/** A reply with the answer-comes-here line after it, once per conversation. */
export const withAnswerHere = (message: string, turns: Turns) =>
  turns?.some(
    (turn) => turn.role === "assistant" && turn.text.includes(ANSWER_HERE)
  )
    ? message
    : `${message}\n\n${ANSWER_HERE}`;

const INVITE_OPENING = "Tell me what you need help with";
const INVITE = `${INVITE_OPENING} and I'll try to sort it out now. Anything I can't, I'll pass to our team, and their answer will come here in this chat.`;

/** An earlier reply was the invitation, so a second bare ask files the ticket instead of looping (ENG-21230). */
export const invitedBefore = (turns: Turns) =>
  turns?.some(
    (turn) => turn.role === "assistant" && turn.text.includes(INVITE_OPENING)
  ) ?? false;

/**
 * The whole reply to an ask for a person that says nothing else. No ticket:
 * one is filed only once the customer describes something Foreman cannot settle.
 */
export const personInvite = (ids: {
  conversationId: string;
  runId: string;
}) => {
  logOpsEvent("widget.handoff.ticket", { ...ids, decision: "invite" });
  return INVITE;
};

type Filed = Exclude<
  Awaited<ReturnType<typeof fileTicketFor>>,
  { error: string }
>;

/**
 * File the conversation's one ticket in place of a handoff (an existing one is
 * reused, commented on and, when Done, reopened), with a title and body the
 * bug writer drafts from the facts. Null when the turn is a teammate's or the
 * ticket could not be filed.
 */
export async function handoffTicket(
  scope: WidgetContext,
  facts: HandoffFacts,
  ids: { runId: string; sessionId?: string },
  signal: AbortSignal | undefined,
  /** Absent, nothing is filed: only callers wired to Linear file. */
  file: typeof fileTicketFor | undefined,
  /** Absent, the ticket is written from the customer's own words. */
  draft?: typeof draftHandoffTicket,
  /** The time left before the caller's deadline, when it has one. */
  roomMs?: number
): Promise<Filed | null> {
  if (!(file && customerTurn(scope))) {
    return null;
  }
  const filed = await file(
    scope,
    await handoffInput(scope, facts, signal, draft, roomMs),
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

/**
 * The title and summary the filer gets. A conversation whose history shows
 * it was filed lands on that ticket as a comment, so it is written without
 * the model; otherwise the drafter writes it, when the caller's deadline
 * leaves the filing its room.
 */
async function handoffInput(
  scope: WidgetContext,
  facts: HandoffFacts,
  signal: AbortSignal | undefined,
  draft: typeof draftHandoffTicket | undefined,
  roomMs: number | undefined
) {
  const drafted =
    draft &&
    !wasFiledEarlier(facts.history) &&
    (roomMs ?? Number.POSITIVE_INFINITY) >= HANDOFF_DRAFT_MS + FILING_ROOM_MS
      ? await draft(facts, signal)
      : fallbackHandoffDraft(facts);
  const body = handoffTicketBody(drafted, facts, scope, new Date());
  return {
    body,
    entry: "handoff" as const,
    ...(facts.refund ? { refund: true as const } : {}),
    report: handoffReport(facts),
    // The refund check reads only this message and why it needs the team.
    summary: `${facts.latest}\n\n${facts.why}`,
    title: drafted.title.slice(0, 160),
  };
}

/** The filed ticket as the findings record it; Acquisity keeps it on the chat. */
export type HandoffTicketRef = NonNullable<WidgetFindings["ticket"]>;

const ticketRef = (filed: {
  identifier: string;
  url: string;
}): HandoffTicketRef => ({ id: filed.identifier, url: filed.url });

/** The ticket filed or reused in place of a handoff, or null when nothing was filed. */
export const ticketInsteadOfHandoff = async (
  ...args: Parameters<typeof handoffTicket>
): Promise<HandoffTicketRef | null> => {
  const filed = await handoffTicket(...args);
  return filed ? ticketRef(filed) : null;
};

/**
 * Findings for a turn that filed the conversation's ticket in place of a
 * handoff. Acquisity records `ticket` on the chat, so the team's answer can be
 * sent into it, and keeps findings only with a report.
 */
export const handoffFindings = (
  report: string,
  ticket: HandoffTicketRef,
  found?: WidgetFindings | null
) => teamFindings(report, found, { recommendation: ANSWER_HERE, ticket });

/**
 * The answer-comes-here line is fixed text added after the gate, to an allowed
 * reply whose turn filed or reused the conversation's ticket, and the findings
 * record that ticket, so Acquisity keeps it on the chat. A blocked reply files
 * its ticket in `ticketInsteadOfBlock`.
 */
export async function withAnswerLine(
  result: WidgetOutcome,
  findings: WidgetFindings,
  filedTicket: HandoffTicketRef | undefined,
  run: Pick<WidgetRun, "id" | "scope">,
  ticket: HandoffTicketRef | null | undefined,
  read: WidgetDependencies["readTicket"],
  signal: AbortSignal,
  history: Turns
): Promise<{ findings: WidgetFindings; result: WidgetOutcome }> {
  if (
    !(customerTurn(run.scope) && result.message) ||
    result.decision === "block"
  ) {
    return { findings, result };
  }
  // An unreadable receipt counts as none; it must not fail an allowed reply.
  const receipt =
    filedTicket || ticket
      ? null
      : await read?.(run.scope, run.id, signal).catch((error) => {
          if (signal.aborted) {
            throw error;
          }
          return null;
        });
  const filed =
    filedTicket ??
    (ticket ? { id: ticket.id, url: ticket.url } : undefined) ??
    (receipt ? ticketRef(receipt) : undefined);
  return filed
    ? {
        // A ticket filed earlier in the turn, such as for a toggled ask for a
        // person, is recorded here; one the findings already carry stays.
        findings: findings.ticket ? findings : { ...findings, ticket: filed },
        result: {
          ...result,
          message: withAnswerHere(result.message, history),
          reason: `${TICKET_INSTEAD} ${result.reason}`,
        },
      }
    : { findings, result };
}

// A block from our own controls (the ownership guard, a gate outage) is not a
// finding that needs a person: the app tells the customer to send the message
// again. The reason itself can name an identifier, so only this flag crosses
// to the app.
export const RETRYABLE_BLOCK =
  /^(?:deadline$|gate_unavailable$|bug_report_unfiled$|(?:composed:)?(?:foreign_identifier|internal_artifact):)/u;

/**
 * A block the customer cannot fix by sending again hands the chat to Fixy, or
 * with escalation off files the conversation's ticket and says the team's
 * answer will come here. A teammate's run, a retryable block and a ticket that
 * could not be filed keep the block.
 */
export async function ticketInsteadOfBlock(
  run: Pick<WidgetRun, "id" | "question" | "scope"> &
    Partial<Pick<WidgetRun, "findings">>,
  result: WidgetOutcome,
  findings: unknown,
  history: HandoffFacts["history"],
  ids: { runId: string; sessionId?: string },
  signal: AbortSignal | undefined,
  file: typeof fileTicketFor | undefined,
  draft?: typeof draftHandoffTicket,
  roomMs?: number,
  read?: WidgetDependencies["readTicket"]
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
  if (escalatesToFixy() && customerTurn(run.scope)) {
    // A ticket the turn filed before it stopped stays with the chat. Its own
    // bound: the finish deadline may already be spent, and the read is local.
    const receipt = await read?.(
      run.scope,
      run.id,
      AbortSignal.timeout(RECEIPT_READ_MS)
    ).catch(() => null);
    return blockedForCustomer(
      run,
      reason,
      found,
      ids,
      receipt ? ticketRef(receipt) : undefined,
      Boolean(receipt && "refund" in receipt && receipt.refund)
    );
  }
  const filed = await handoffTicket(
    run.scope,
    {
      findings: found ?? undefined,
      history,
      latest: run.question,
      why: `Foreman could not answer it (${reason}).`,
    },
    ids,
    signal,
    file,
    draft,
    roomMs
  );
  if (!filed) {
    return { findings, result };
  }
  return {
    findings: handoffFindings(
      `Foreman could not answer this (${reason}) and filed the conversation's ticket.`,
      ticketRef(filed),
      found
    ),
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

/** What the front-door ticket is drafted from. */
export const frontDoorTicket = (
  why: FrontDoorTicket,
  scope: WidgetContext,
  ask: { latest: string; turns?: HandoffFacts["history"] },
  reply: string,
  refund = false
): HandoffFacts => ({
  history: ask.turns,
  latest: ask.latest,
  ...(refund ? { refund: true as const } : {}),
  reply,
  why:
    why === "person"
      ? "The customer asked for a person."
      : `The customer is a workspace ${scope.role}, and only an owner or admin can start a look into their workspace.`,
});

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

/** An earlier reply in the history told the customer their conversation has a ticket. */
const wasFiledEarlier = (history: Turns) =>
  history?.some(
    (turn) =>
      turn.role === "assistant" &&
      FILED_REPLIES.some((line) => turn.text.includes(line))
  ) ?? false;

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
    wasFiledEarlier(input.history) ||
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

const investigatorDependencies = {
  draft: draftHandoffTicket,
  file: fileWidgetTicket,
  /** The run's own message and the earlier turns, read only for this verified scope. */
  turns: async (scope: WidgetContext, runId: string, signal: AbortSignal) => {
    const run = await readWidgetRun(runId, signal);
    assertWidgetRunOwner(run, scope);
    return { history: await recentWidgetTurns(run), question: run.question };
  },
};

/**
 * widget_file_ticket: the investigator's title and summary are its findings,
 * and the ticket is drafted from them and the conversation by the same call
 * as every other widget ticket, so its body carries no ids. The summary goes
 * in the Support report as written.
 */
export async function fileInvestigatorTicket(
  ctx: ProviderContext,
  input: { summary: string; title: string },
  overrides: Partial<typeof investigatorDependencies> = {}
) {
  const deps = { ...investigatorDependencies, ...overrides };
  if (isLiveActive()) {
    return await deps.file(ctx, {
      body: input.summary,
      entry: "tool",
      report: [],
      summary: input.summary,
      title: input.title,
    });
  }
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const runId = z
    .uuid()
    .optional()
    .safeParse(ctx.session?.auth.current?.attributes?.widgetRunId).data;
  const turns = runId
    ? await deps.turns(scope, runId, ctx.abortSignal).catch((error) => {
        if (ctx.abortSignal.aborted) {
          throw error;
        }
        return null;
      })
    : null;
  const facts: HandoffFacts = {
    findings: { recommendation: input.title, report: input.summary },
    ...(turns?.history.length ? { history: turns.history } : {}),
    latest:
      turns?.question ?? "(The customer's latest message could not be read.)",
    why: "Foreman's investigation found something the team needs to act on.",
  };
  const draft = await deps.draft(facts, ctx.abortSignal);
  return await deps.file(ctx, {
    body: handoffTicketBody(draft, facts, scope, new Date()),
    entry: "tool",
    report: handoffReport(facts),
    summary: `${input.title}\n\n${input.summary}`,
    title: draft.title.slice(0, 160),
  });
}
