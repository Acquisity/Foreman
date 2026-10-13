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

/**
 * The team's published schedule as a server-owned note for the front-door
 * writers, so a question about when a person is available, the hours or a
 * holiday gets the real answer, open or closed (ENG-15262). Null with office
 * hours off or absent, or with any part of the schedule missing, so those
 * prompts stay exactly as before.
 */
export const officeSchedule = (scope: WidgetContext): string | null => {
  const hours = scope.source === "widget" ? scope.officeHours : undefined;
  if (
    !(
      hours?.enabled &&
      hours.hoursText?.length &&
      hours.timeZoneName &&
      hours.upcomingClosures
    )
  ) {
    return null;
  }
  const closures = hours.upcomingClosures.map(
    ({ date, hours: times, label }) =>
      `${date}${label ? ` (${label})` : ""}: ${times}`
  );
  return [
    `The support team's hours, from the app, in ${hours.timeZoneName}: ${hours.hoursText.join("; ")}.`,
    closures.length
      ? `Closures in the next 90 days: ${closures.join("; ")}.`
      : "No closures are scheduled in the next 90 days.",
    `The team is ${hours.open ? "open" : "away"} right now. When the customer asks when the team or a person is available, the hours, or about holidays or closures, answer from these hours and closures and name the time zone. They are the team's published schedule, not a promise of a reply, so stating them is allowed. Say only what they say, and mention a closure only when it is relevant.`,
  ].join(" ");
};

/** Fixed wording, so no model can promise a person sooner; the time is the app's, in the customer's timezone. */
export const backAtLine = (hours: OfficeHours) =>
  hours.showReplyTime && hours.nextOpenText
    ? `Our team is away right now. We're back ${hours.nextOpenText}, and a teammate will pick this up then.`
    : "Our team is away right now, and a teammate will pick this up when they're back.";

type Turns = { role: "customer" | "assistant"; text: string }[] | undefined;

/**
 * Whether an earlier reply in this conversation already gave this exact line.
 * Compared with the line built now, so a changed back-at time shows again.
 */
const toldAlready = (line: string, turns: Turns) =>
  turns?.some(
    (turn) => turn.role === "assistant" && turn.text.includes(line)
  ) ?? false;

/** A reply with the away line after it, once per conversation (ENG-15262). */
export const withBackAt = (message: string, line: string, turns: Turns) =>
  toldAlready(line, turns) ? message : `${message}\n\n${line}`;

/** The outcome reason of an after-hours ask for a person that stated no need: no ticket, nothing to act on yet. */
export const AFTER_HOURS_INVITE = "after_hours_invite";

/**
 * The whole reply to an after-hours ask for a person that says nothing else
 * (ENG-15262), or the invitation alone once the line was given. No ticket:
 * one is filed later only if the customer then describes a problem Foreman
 * cannot resolve.
 */
export const awayInvite = (
  hours: OfficeHours,
  ids: { conversationId: string; runId: string },
  turns: Turns
) => {
  logOpsEvent("widget.handoff.after_hours", { ...ids, decision: "invite" });
  const line = backAtLine(hours);
  return toldAlready(line, turns)
    ? "Tell me what you need help with and I'll try to sort it out now."
    : `${line} In the meantime, tell me what you need help with and I'll try to sort it out now.`;
};

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
