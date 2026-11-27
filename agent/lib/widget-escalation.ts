import { logOpsEvent } from "./ops-log.js";
import {
  type EscalationReason,
  teamFindings,
  type WidgetFindings,
} from "./widget-findings.js";
import type { WidgetRoute } from "./widget-router.js";
import type { WidgetOutcome } from "./widget-run-store.js";
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
 * member or client whose workspace needs a look they cannot start. Null while
 * escalation is off and for every other turn.
 */
export const escalationFor = (
  scope: WidgetContext,
  ask: TeamAsk | null,
  route: WidgetRoute,
  { refund }: { refund: boolean }
): Escalation | null => {
  if (!(escalatesToFixy() && customerTurn(scope))) {
    return null;
  }
  const escalate = (reason: EscalationReason, report: string) => ({
    reason,
    report,
  });
  if (route.cancel) {
    return escalate("cancel", "The customer asked to cancel.");
  }
  if (refund && route.refund) {
    return escalate("refund", "The customer asked for a refund.");
  }
  if (ask === "person") {
    return escalate("asked_for_human", "The customer asked for a person.");
  }
  return ask === "member"
    ? escalate(
        "cant_check",
        `The customer is a workspace ${scope.role}, and only an owner or admin can start a look into their workspace.`
      )
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
