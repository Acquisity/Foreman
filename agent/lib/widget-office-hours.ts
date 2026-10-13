import { logOpsEvent } from "./ops-log.js";
import type { OfficeHours, WidgetContext } from "./widget-scope.js";
import { fileTicketFor } from "./widget-ticket.js";

/** The outcome reason, or its prefix, of a reply that filed a ticket in place of a handoff. */
export const AFTER_HOURS_TICKET = "after_hours_ticket";

const TICKET_TIMEOUT_MS = 30_000;

/** The team is away for this customer turn. A teammate's own inbox run is never after hours. */
export const awayHours = (scope: WidgetContext): OfficeHours | null =>
  scope.source === "widget" && scope.officeHours?.open === false
    ? scope.officeHours
    : null;

/** Fixed wording, so no model can promise a person sooner; the time is the app's, in the customer's timezone. */
export const backAtLine = (hours: OfficeHours) =>
  hours.showReplyTime && hours.nextOpenText
    ? `Our team is away right now. We're back ${hours.nextOpenText}, and a teammate will pick this up then.`
    : "Our team is away right now, and a teammate will pick this up when they're back.";

/**
 * The after-hours rule (ENG-15262), for every turn that would hand the
 * conversation to a person: an explicit ask for one, or findings that need one.
 * After hours nobody is there to take it, so the conversation's one ticket is
 * filed instead (an existing one is reused) and the reply says when the team is
 * back. Returns that line, or null to hand off as today: in office hours, with
 * no office hours sent, or when the ticket could not be filed.
 */
export async function ticketInsteadOfHandoff(
  scope: WidgetContext,
  ticket: { summary: string; title: string },
  ids: { runId: string; sessionId?: string },
  signal?: AbortSignal,
  file: typeof fileTicketFor = fileTicketFor
): Promise<string | null> {
  const hours = awayHours(scope);
  if (!hours) {
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
  logOpsEvent("widget.handoff.after_hours", {
    conversationId: scope.conversationId,
    decision: ok ? "ticket" : "handoff",
    ...ids,
  });
  return ok ? backAtLine(hours) : null;
}
