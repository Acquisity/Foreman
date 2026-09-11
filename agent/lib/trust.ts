import type { SessionAuthContext } from "eve/context";

/**
 * Deny compatibility for durable sessions created before automatic GitHub
 * dispatch was removed. No channel creates this principal anymore.
 */
export const isRetiredSessionAuth = (
  auth: SessionAuthContext | null
): boolean => auth?.principalId === "github:foreman-factory";

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

/** Whether this is a scheduled dispatch or a retired unattended session. */
export function isUnattended(auth: SessionAuthContext | null): boolean {
  return (
    isRetiredSessionAuth(auth) ||
    auth?.attributes[UNATTENDED_ATTRIBUTE] === "true"
  );
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
