import type { SessionAuthContext } from "eve/context";

/**
 * Auth attribute marking a caller the dispatching channel decided to trust.
 *
 * @remarks
 * Trust is decided once, at dispatch, on the signed webhook: the GitHub
 * channel stamps it only for commenters whose `author_association` is
 * OWNER, MEMBER, or COLLABORATOR; the Linear channel stamps it for every
 * Agent Session, because workspace membership is the gate there. Nothing
 * downstream re-derives trust from model-readable content.
 */
export const TRUSTED_ATTRIBUTE = "trusted";

/**
 * Returns a copy of `auth` carrying the {@link TRUSTED_ATTRIBUTE} stamp.
 *
 * @remarks
 * Channels call this at dispatch, next to the authorization decision itself,
 * so the stamp and the gate can never drift apart.
 */
export function stampTrusted(auth: SessionAuthContext): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [TRUSTED_ATTRIBUTE]: "true" },
  };
}

/**
 * Auth attribute marking a session that nobody is watching, even though it
 * carries a real user principal.
 *
 * @remarks
 * Schedules that reach `principalType: "user"` connections must dispatch under
 * the granting user. Without
 * this stamp such a turn would look attended: approval cards would park with
 * nobody to answer them, and the unattended write denials would not fire.
 */
export const UNATTENDED_ATTRIBUTE = "unattended";

/** Returns a copy of `auth` marked as an unattended schedule dispatch. */
export function stampUnattended(auth: SessionAuthContext): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [UNATTENDED_ATTRIBUTE]: "true" },
  };
}

/** Whether this is an unattended scheduled dispatch. */
export function isUnattended(auth: SessionAuthContext | null): boolean {
  return auth?.attributes[UNATTENDED_ATTRIBUTE] === "true";
}

/**
 * Whether the dispatching channel stamped this caller as trusted.
 *
 * @remarks
 * This predicate gates the shared-config write policies in
 * `agent/lib/github/approval.ts` and `deliveryPolicy` (wired to the root
 * `push_branch` tool only): trusted callers write repository knowledge and
 * model overrides directly and push without a card, everyone else parks on
 * one. The GitHub extension write tools (createPullRequest, addIssueComment,
 * etc.) are ungated for every caller only because `agent/extensions/github/extension.ts`
 * sets `requireApproval: false`; the extension defaults to `always()` on every
 * write tool. New capabilities gate on this
 * predicate (or {@link isUnattended} / {@link isScheduleAppAuth}) rather than
 * inventing their own.
 */
export function isTrusted(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.attributes[TRUSTED_ATTRIBUTE] === "true";
}

/**
 * The app principal eve stamps on schedule-dispatched turns.
 *
 * @remarks
 * Every schedule that ships marks itself unattended before dispatch:
 * `sla-report.ts` sets {@link UNATTENDED_ATTRIBUTE}, which is caught by
 * {@link isUnattended} and denied, so it never reaches this predicate. It
 * recognizes the raw app principal for a future schedule that dispatches
 * without either marker, and the write policies treat that as trusted. Mark
 * new schedules unattended unless they are meant to write without a card.
 * It is never a user identity.
 */
export function isScheduleAppAuth(auth: SessionAuthContext | null): boolean {
  return (
    auth !== null &&
    auth.authenticator === "app" &&
    auth.principalId === "eve:app" &&
    auth.principalType === "runtime"
  );
}

/**
 * Auth attribute marking a session dispatched from an intake-only channel.
 *
 * @remarks
 * Stamped by the Slack channel at dispatch, next to the trust decision, on
 * the signed webhook. Conversation in those channels runs normally; the
 * attribute is what `intakeOnlyPolicy` in `agent/lib/github/approval.ts`
 * gates repository work on, so the stop gate never depends on the model
 * honoring injected instructions.
 */
export const INTAKE_ONLY_ATTRIBUTE = "intakeOnly";

/**
 * Returns a copy of `auth` carrying the {@link INTAKE_ONLY_ATTRIBUTE} stamp.
 */
export function stampIntakeOnly(auth: SessionAuthContext): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [INTAKE_ONLY_ATTRIBUTE]: "true" },
  };
}

/**
 * Whether the dispatching channel marked this session intake-only.
 */
export function isIntakeOnly(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.attributes[INTAKE_ONLY_ATTRIBUTE] === "true";
}

/**
 * Auth attribute marking a session opened from an Asks-receiver triage intake
 * channel (feedback, refunds), either by the receiver's Slack mention or by a
 * Linear Agent Session on a ticket whose 'Ask from' link points there.
 *
 * @remarks
 * It selects models only (ENG-15226): the root investigates on the `triage`
 * slot and the requester reply and investigation document are reworded by the
 * `writer` slot. It grants nothing.
 */
export const TRIAGE_INTAKE_ATTRIBUTE = "triageIntake";

/**
 * Returns a copy of `auth` carrying the {@link TRIAGE_INTAKE_ATTRIBUTE} stamp.
 */
export function stampTriageIntake(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [TRIAGE_INTAKE_ATTRIBUTE]: "true" },
  };
}

/**
 * Whether the session was opened from a triage intake channel.
 */
export function isTriageIntake(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.attributes[TRIAGE_INTAKE_ATTRIBUTE] === "true";
}

/**
 * Auth attribute marking a Linear follow-up that Jev read as only asking to
 * move the ticket to a status a person already decided (ENG-14387).
 *
 * @remarks
 * Stamped by the Linear channel on the turn it judged, so `route_ticket` can
 * let that one state move through a critic block (ENG-16055). It grants no
 * other route.
 */
export const STATUS_FOLLOW_UP_ATTRIBUTE = "statusFollowUp";

/** Returns a copy of `auth` carrying the {@link STATUS_FOLLOW_UP_ATTRIBUTE} stamp. */
export function stampStatusFollowUp(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [STATUS_FOLLOW_UP_ATTRIBUTE]: "true" },
  };
}

/** Whether the channel judged this turn a status-only follow-up. */
export function isStatusFollowUp(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.attributes[STATUS_FOLLOW_UP_ATTRIBUTE] === "true";
}

/**
 * Auth attribute marking a Slack session from a questions-only channel.
 *
 * @remarks
 * Stamped by the Slack channel at dispatch, alongside the intake-only stamp.
 * A tag in those channels gets an answer in the thread and never Linear work:
 * `questionsOnlyPolicy` in `agent/lib/github/approval.ts` denies the raw
 * Executor gateway and the Linear-writing root tools, and the typed Executor
 * client refuses Linear mutations, so the boundary never depends on the model
 * honoring injected instructions. Bugs go through the channel's intake form.
 */
export const QUESTIONS_ONLY_ATTRIBUTE = "questionsOnly";

/**
 * Returns a copy of `auth` carrying the {@link QUESTIONS_ONLY_ATTRIBUTE} stamp.
 */
export function stampQuestionsOnly(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [QUESTIONS_ONLY_ATTRIBUTE]: "true" },
  };
}

/**
 * Whether the dispatching channel marked this session questions-only.
 */
export function isQuestionsOnly(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.attributes[QUESTIONS_ONLY_ATTRIBUTE] === "true";
}

/**
 * Auth attribute marking the automatic session a new Stripe dispute alert
 * starts in the disputes channel (ENG-16255).
 *
 * @remarks
 * Stamped only by the Slack channel's `onEvent`, next to the unattended
 * stamp, on an alert this Slack app posted. It lets `respond_stripe_dispute`
 * stage evidence and grants nothing else. Submitting always needs a person.
 */
export const STRIPE_DISPUTE_ATTRIBUTE = "stripeDispute";

/** Returns a copy of `auth` carrying the {@link STRIPE_DISPUTE_ATTRIBUTE} stamp. */
export function stampStripeDispute(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [STRIPE_DISPUTE_ATTRIBUTE]: "true" },
  };
}

/**
 * Auth attribute naming the one dispute a Slack turn may write: the `du_` id
 * read from the alert this app posted at the root of the turn's thread.
 */
export const STRIPE_DISPUTE_ID_ATTRIBUTE = "stripeDisputeId";

/** Returns a copy of `auth` bound to the dispute in its thread's alert. */
export function stampStripeDisputeId(
  auth: SessionAuthContext,
  disputeId: string
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [STRIPE_DISPUTE_ID_ATTRIBUTE]: disputeId,
    },
  };
}

/** The dispute this turn's thread alert names, if any. */
export function stripeDisputeIdOf(
  auth: SessionAuthContext | null | undefined
): string | undefined {
  const id = auth?.attributes[STRIPE_DISPUTE_ID_ATTRIBUTE];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Auth attribute marking a Slack turn whose own message is a person's literal
 * "approve" in a dispute alert thread. Only that turn may submit.
 */
export const STRIPE_DISPUTE_APPROVAL_ATTRIBUTE = "stripeDisputeApproved";

/** Returns a copy of `auth` carrying a person's approval for this turn. */
export function stampStripeDisputeApproval(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [STRIPE_DISPUTE_APPROVAL_ATTRIBUTE]: "true",
    },
  };
}

/** Whether this turn's message was a person's literal "approve". */
export function isStripeDisputeApproval(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.attributes[STRIPE_DISPUTE_APPROVAL_ATTRIBUTE] === "true";
}

/** Whether this is the automatic Stripe dispute session. */
export function isStripeDisputeSession(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.attributes[STRIPE_DISPUTE_ATTRIBUTE] === "true";
}

/**
 * Auth attribute marking a session authorized to read and write investigation
 * memory.
 *
 * @remarks
 * Deliberately separate from {@link TRUSTED_ATTRIBUTE}. Trust answers whether
 * a caller may write shared repository configuration; this answers whether
 * they may read Acquisity's internal customer-support investigation history,
 * which is a narrower question with a different answer. A trusted GitHub
 * collaborator is exactly the caller the two must not agree on.
 *
 * Stamped only on operational surfaces that run triage: Linear Agent Sessions,
 * every Slack surface the app is invited into, and the local dev TUI. Never on GitHub
 * sessions or schedules.
 */
export const INVESTIGATION_MEMORY_ATTRIBUTE = "investigationMemory";

/**
 * Returns a copy of `auth` carrying the {@link INVESTIGATION_MEMORY_ATTRIBUTE}
 * stamp.
 */
export function stampInvestigationMemory(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [INVESTIGATION_MEMORY_ATTRIBUTE]: "true",
    },
  };
}

/**
 * Whether the dispatching channel authorized this session for investigation
 * memory. Fail-closed: an unstamped session, and every session that predates
 * the stamp, reads nothing.
 */
export function canUseInvestigationMemory(
  auth: SessionAuthContext | null
): boolean {
  return (
    auth !== null &&
    auth.attributes[INVESTIGATION_MEMORY_ATTRIBUTE] === "true" &&
    !isUnattended(auth)
  );
}

/**
 * Whether this session came from a Linear Agent Session.
 *
 * @remarks
 * eve's default Linear auth stamps `agent_session_id` on every Linear
 * dispatch. Intake now runs there, so master search applies the same 30-day
 * window it applies to intake-only Slack sessions.
 */
export function isLinearSession(auth: SessionAuthContext | null): boolean {
  return Boolean(auth?.attributes.agent_session_id);
}
