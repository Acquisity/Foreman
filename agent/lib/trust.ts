import type { SessionAuthContext } from "eve/context";

/**
 * Constructed principal for unattended factory runs (an issue labeled
 * `factory`).
 *
 * @remarks
 * Real GitHub actors project as numeric `github:<id>` principals, so this
 * fixed login can never collide with one. The GitHub channel stamps it at
 * dispatch; the remaining approval policies (repositoryKnowledgePolicy,
 * modelSwapPolicy, denyUnattendedWrites) deny it non-GitHub writes
 * (repository knowledge, model swaps, connection writes), because an
 * unattended turn has nobody to answer an approval card and would park
 * forever.
 */
export const AUTONOMOUS_PRINCIPAL = "github:foreman-factory";

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
 * Auth attribute carrying the issue number an unattended run was dispatched
 * from.
 *
 * @remarks
 * Stamped by {@link stampAutonomous} at dispatch, on the signed webhook, so
 * the run can reference its own intake issue. Attribute values are strings;
 * read it back through {@link intakeIssueNumber}.
 */
export const INTAKE_ISSUE_ATTRIBUTE = "intakeIssue";

/**
 * Rewrites a channel auth into the unattended factory principal, carrying the
 * intake issue number.
 *
 * @remarks
 * The GitHub channel calls this when the factory label is applied: the
 * webhook sender's identity is replaced (the turn must never run as the
 * labeler), and the issue number is stamped so the run can reference its own
 * intake issue.
 */
export function stampAutonomous(
  auth: SessionAuthContext,
  intakeIssue: number
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [INTAKE_ISSUE_ATTRIBUTE]: String(intakeIssue),
    },
    principalId: AUTONOMOUS_PRINCIPAL,
    principalType: "service",
  };
}

/**
 * The issue number an unattended run was dispatched from, or null when the
 * session is not an unattended run (or predates the stamp).
 */
export function intakeIssueNumber(
  auth: SessionAuthContext | null
): number | null {
  if (!isAutonomous(auth)) {
    return null;
  }
  const stamped = auth?.attributes[INTAKE_ISSUE_ATTRIBUTE];
  if (typeof stamped !== "string" || stamped === "") {
    return null;
  }
  const issue = Number(stamped);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

/**
 * Auth attribute marking a session that nobody is watching, even though it
 * carries a real user principal.
 *
 * @remarks
 * Schedules that reach `principalType: "user"` connections must dispatch under
 * the granting user, so they cannot use {@link AUTONOMOUS_PRINCIPAL}. Without
 * this stamp such a turn would look attended: approval cards would park with
 * nobody to answer them, and the unattended write denials would not fire.
 */
export const UNATTENDED_ATTRIBUTE = "unattended";

/**
 * Whether nobody is watching this session, whether it runs under
 * {@link AUTONOMOUS_PRINCIPAL} or under a user principal a schedule stamped
 * with {@link UNATTENDED_ATTRIBUTE}. Write policies gate on this; anything
 * specific to factory intake keeps using {@link isAutonomous}.
 */
export function isUnattended(auth: SessionAuthContext | null): boolean {
  return (
    isAutonomous(auth) || auth?.attributes[UNATTENDED_ATTRIBUTE] === "true"
  );
}

/**
 * Whether the session runs unattended under {@link AUTONOMOUS_PRINCIPAL}.
 */
export function isAutonomous(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.principalId === AUTONOMOUS_PRINCIPAL;
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
 * etc.) are ungated for every caller only because `agent/extensions/github.ts`
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

/** Auth attribute granting the app-scoped billing API read tools. */
export const BILLING_API_READ_ATTRIBUTE = "billingApiRead";

/**
 * Grants access to the fixed, read-only Autumn and Stripe API lookups.
 *
 * @remarks
 * Slack stamps this only for an intake-only channel mapped to billing triage.
 * The tools check the stamp again at execution, so merely discovering or
 * loading the billing skill never grants access.
 */
export function stampBillingApiRead(
  auth: SessionAuthContext
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [BILLING_API_READ_ATTRIBUTE]: "true",
    },
  };
}

/** Whether this attended session may use app-scoped billing API reads. */
export function canUseBillingApiRead(auth: SessionAuthContext | null): boolean {
  return (
    auth !== null &&
    auth.attributes[BILLING_API_READ_ATTRIBUTE] === "true" &&
    isIntakeOnly(auth) &&
    !isUnattended(auth)
  );
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
 * sessions, never on unattended factory runs, and never on schedules.
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
