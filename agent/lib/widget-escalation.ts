import { logOpsEvent } from "./ops-log.js";
import {
  type EscalationReason,
  teamFindings,
  type WidgetFindings,
} from "./widget-findings.js";
import type { WidgetRoute } from "./widget-router.js";
import {
  refundAsked,
  type WidgetOutcome,
  type WidgetTicketReceipt,
} from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";

/**
 * WIDGET_ESCALATE_TO_FIXY=on hands every chat that needs more than Foreman to
 * Fixy (ENG-21094): Foreman returns why in the findings, says nothing to the
 * customer (Fixy sends the one acknowledgement) and files no ticket for the
 * escalation. Off, those turns file the conversation's ticket as before. It
 * stays off until Fixy answers the chats it is given (ENG-21093).
 */
export const escalatesToFixy = (env: NodeJS.ProcessEnv = process.env) =>
  env.WIDGET_ESCALATE_TO_FIXY === "on";

/** A customer's own turn. A teammate's inbox run is team-only and never files or escalates. */
export const customerTurn = (scope: WidgetContext) => scope.source === "widget";

/**
 * With escalation on, asking for a person in this chat reaches one at any
 * time, so the front-door writers say that in place of "nobody is notified",
 * a set phrase to type, or support hours, which the generated guide may still
 * carry (ENG-21099).
 */
export const PERSON_HERE_RULE =
  'When the customer needs a person, tell them they can ask for one right here in this chat at any time, and Support will answer here. Never tell them to type a set phrase such as "human agent", to contact support as a step or anywhere else, or to wait for support hours, and never give support hours, even where the help center says so.';

/** An earlier Foreman reply offered the magnifying glass; Foreman words it one way. */
export const offeredGlass = (
  turns: { role: "customer" | "assistant"; text: string }[] | undefined
) =>
  (turns ?? []).some(
    (turn) =>
      turn.role === "assistant" && turn.text.includes("magnifying glass")
  );

const ESCALATED = "escalated_to_fixy";

/**
 * Why a customer's turn needs the team: they asked for a person, or they are a
 * member or client who needs their workspace looked into (the magnifying
 * glass, a bug, a refund or a ticket) and cannot start an investigation
 * (ENG-20283 default). A teammate's run never does.
 */
export type TeamAsk = "person" | "member";

export const teamAsk = (
  scope: WidgetContext,
  route: WidgetRoute,
  {
    helpCenterOnly,
    needsLook,
    person,
  }: { helpCenterOnly: boolean; needsLook: boolean; person: boolean }
): TeamAsk | null => {
  if (!customerTurn(scope)) {
    return null;
  }
  if (person) {
    return "person";
  }
  return helpCenterOnly &&
    (needsLook || route.bug || route.refund || route.ticket)
    ? "member"
    : null;
};

export interface Escalation {
  reason: EscalationReason;
  report: string;
}

/**
 * The escalation a customer's turn gets, most specific need first: a cancel,
 * then a refund (only where Foreman would not investigate and file it itself),
 * then an ask for a person (a bare one too: Fixy asks what they need), then a
 * member or client whose workspace needs a look they cannot start, then an
 * owner or admin asking for a ticket after Foreman's fixed magnifying-glass
 * reply, so the redirect is never given twice (ENG-21099). Null while
 * escalation is off and for every other turn.
 */
export const escalationFor = (
  scope: WidgetContext,
  ask: TeamAsk | null,
  route: WidgetRoute,
  {
    redirected = false,
    refund,
  }: {
    /** An earlier reply was Foreman's fixed magnifying-glass redirect. */
    redirected?: boolean;
    refund: boolean;
  }
): Escalation | null => {
  if (!(escalatesToFixy() && customerTurn(scope))) {
    return null;
  }
  if (route.cancel) {
    return { reason: "cancel", report: "The customer asked to cancel." };
  }
  if (refund && route.refund) {
    return { reason: "refund", report: "The customer asked for a refund." };
  }
  if (ask === "person") {
    return {
      reason: "asked_for_human",
      report: "The customer asked for a person.",
    };
  }
  if (ask === "member") {
    return {
      reason: "cant_check",
      report: `The customer is a workspace ${scope.role}, and only an owner or admin can start a look into their workspace.`,
    };
  }
  return redirected && route.ticket
    ? {
        reason: "asked_for_human",
        report:
          "The customer asked for a ticket after Foreman had already pointed them to the magnifying glass.",
      }
    : null;
};

/**
 * The findings and outcome of a turn that hands the chat to Fixy: no message,
 * because Fixy sends the one acknowledgement, and nothing filed. A ticket the turn
 * already filed stays on the findings, so Acquisity keeps it on the chat.
 */
export function escalated(
  escalation: Escalation,
  found: WidgetFindings | null | undefined,
  ids: { conversationId: string; runId: string; sessionId?: string },
  /** A ticket this turn filed that `found` does not carry. */
  filed?: WidgetFindings["ticket"]
): { findings: WidgetFindings | null; result: WidgetOutcome } {
  const ticket = found?.ticket ?? filed;
  logOpsEvent("widget.handoff.escalate", {
    ...ids,
    decision: escalation.reason,
  });
  return {
    findings: teamFindings(escalation.report, found, {
      escalate: { reason: escalation.reason },
      recommendation: found?.recommendation ?? escalation.report,
      ...(found?.needsWrite ? { needsWrite: found.needsWrite } : {}),
      ...(ticket ? { ticket } : {}),
    }),
    result: {
      citations: [],
      decision: "allow",
      message: null,
      reason: `${ESCALATED} ${escalation.reason}`,
      status: "completed",
    },
  };
}

interface RunIds {
  id: string;
  question: string;
  scope: WidgetContext;
}

/** Findings that still need a person after the investigation, handed to Fixy as cant_check. */
export const needsTheTeam = (
  run: RunIds,
  sessionId: string,
  found: WidgetFindings
) =>
  escalated(
    {
      reason: "cant_check",
      report:
        "Foreman's investigation found something only the team can settle and handed the chat to Fixy.",
    },
    found,
    { conversationId: run.scope.conversationId, runId: run.id, sessionId }
  );

/**
 * An owner's toggled refund still investigates and files its own ticket, but
 * the investigator files only once the charge is named (ENG-21231). A refund
 * the conversation has no refund ticket for yet is marked on the run, so a
 * finish that files none hands it to Fixy.
 */
export const marksRefund = (
  scope: WidgetContext,
  route: WidgetRoute,
  refundTicketed: boolean
) =>
  route.refund === true &&
  !refundTicketed &&
  escalatesToFixy() &&
  customerTurn(scope);

/** Marks a toggled refund for the finish. A failed write loses only that handoff. */
export async function markToggledRefund(
  run: { findings: unknown; id: string },
  scope: WidgetContext,
  route: WidgetRoute,
  note: { refund?: true } | null,
  mark: ((id: string) => Promise<void>) | undefined
) {
  if (!(mark && marksRefund(scope, route, note?.refund === true))) {
    return;
  }
  try {
    await mark(run.id);
  } catch {
    logOpsEvent(
      "widget.refund.mark_failed",
      { conversationId: scope.conversationId, runId: run.id },
      console.warn
    );
    return;
  }
  // The in-process finish reads this same row object.
  run.findings = {
    ...(run.findings as Record<string, unknown> | null),
    refundAsked: true,
  };
}

/** A ticket the turn filed, with whether it went to billing as a refund. */
export type FiledTicket = NonNullable<WidgetFindings["ticket"]> & {
  refund?: true;
};

/**
 * A marked refund's finish: the turn's ticket, else its saved receipt (an
 * unreadable one counts as none), says whether a refund ticket was filed.
 * Without one the chat goes to Fixy with what Foreman read. Null otherwise.
 */
export async function refundHandoff(
  run: RunIds & { findings: unknown },
  sessionId: string,
  turn: {
    read?: (
      scope: WidgetContext,
      id: string,
      signal: AbortSignal
    ) => Promise<WidgetTicketReceipt | null>;
    signal: AbortSignal;
    ticket: FiledTicket | null | undefined;
  },
  findingsWith: (
    ticket: FiledTicket | null | undefined
  ) => WidgetFindings | null
) {
  if (
    !(refundAsked(run.findings) && escalatesToFixy() && customerTurn(run.scope))
  ) {
    return null;
  }
  const receipt = turn.ticket
    ? null
    : await turn.read?.(run.scope, run.id, turn.signal).catch(() => null);
  const ticket =
    receipt && "existing" in receipt
      ? {
          id: receipt.identifier,
          url: receipt.url,
          ...(receipt.refund ? { refund: true as const } : {}),
        }
      : turn.ticket;
  if (ticket?.refund) {
    return null;
  }
  return escalated(
    {
      reason: "refund",
      report:
        "The customer asked for a refund and Foreman's investigation filed no refund ticket, so the chat was handed to Fixy with what it read.",
    },
    findingsWith(ticket),
    { conversationId: run.scope.conversationId, runId: run.id, sessionId }
  );
}

/**
 * A customer's investigation that could not start goes to Fixy rather than a
 * dead end. Null for a teammate's run and while escalation is off, which keep
 * the block.
 */
export const couldNotStart = (run: RunIds) =>
  escalatesToFixy() && customerTurn(run.scope)
    ? escalated(
        {
          reason: "blocked",
          report:
            "Foreman's investigation could not start, so the chat was handed to Fixy.",
        },
        null,
        { conversationId: run.scope.conversationId, runId: run.id }
      )
    : null;

/** A block a resend cannot fix, handed to Fixy, with any ticket the turn filed before it stopped. */
export const blockedForCustomer = (
  run: RunIds,
  reason: string,
  found: WidgetFindings | null,
  ids: { runId: string; sessionId?: string },
  filed?: WidgetFindings["ticket"]
) =>
  escalated(
    {
      reason: "blocked",
      report: `Foreman could not answer this (${reason}) and handed the chat to Fixy.`,
    },
    found,
    { conversationId: run.scope.conversationId, ...ids },
    filed
  );

/**
 * Complete a front-door or toggled turn by handing the chat to Fixy. No
 * session exists on these lanes, so the run id is the fencing session id.
 */
export const completeEscalation = <T>(
  complete: (
    runId: string,
    result: WidgetOutcome,
    findings: unknown,
    sessionId: string
  ) => Promise<T>,
  runId: string,
  scope: WidgetContext,
  escalation: Escalation
) => {
  const { findings, result } = escalated(escalation, null, {
    conversationId: scope.conversationId,
    runId,
  });
  return complete(runId, result, findings, runId);
};
