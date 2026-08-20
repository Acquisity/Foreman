import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import {
  isIntakeOnly,
  isScheduleAppAuth,
  isTrusted,
  isUnattended,
} from "../trust.js";

/**
 * Policy factory for the shared write ladder.
 *
 * @remarks
 * Unattended runs are denied rather than parked: nobody is watching to
 * answer an approval card, and because these writes become context or
 * behavior for every later run, untrusted input reaching one could poison
 * shared state. Trusted callers and schedule turns write without a card,
 * and every other human caller, the dev TUI included, parks on one. Reads
 * are never routed here. The denial reason is per-surface so a relayed
 * refusal names the right feature.
 */
function attendedWritePolicy(unattendedReason: string) {
  return (ctx: ApprovalContext): ApprovalStatus => {
    const auth = ctx.session.auth.current;
    if (isUnattended(auth)) {
      return { reason: unattendedReason, type: "denied" };
    }
    return isTrusted(auth) || isScheduleAppAuth(auth)
      ? "not-applicable"
      : "user-approval";
  };
}

/**
 * Verified repository knowledge that can feed future runs for that repository.
 */
export const repositoryKnowledgePolicy = attendedWritePolicy(
  "Unattended runs may read repository knowledge but not write to it."
);

/**
 * The live model overrides: which model each factory agent runs on, applied
 * to every session that starts after the change.
 */
export const modelSwapPolicy = attendedWritePolicy(
  "Unattended runs may not change the models the factory runs on."
);

/**
 * Rebuilding the warm repository snapshot: a several-minute sandbox build that
 * costs real compute.
 *
 * @remarks
 * Denies rather than parks. Slack and Linear cannot answer an approval card, so
 * a card there is a session that never finishes, and nobody outside the trusted
 * set has a reason to spend the compute in the first place. Slack mentions and
 * Linear agent sessions are stamped trusted at dispatch, so a request from
 * either surface runs the rebuild directly.
 */
export const warmSnapshotPolicy = (ctx: ApprovalContext): ApprovalStatus => {
  const auth = ctx.session.auth.current;
  if (isUnattended(auth)) {
    return {
      reason: "Unattended runs may not rebuild the warm repository snapshot.",
      type: "denied",
    };
  }
  return isTrusted(auth) || isScheduleAppAuth(auth)
    ? "not-applicable"
    : {
        reason:
          "Rebuilding the warm repository snapshot is limited to trusted callers.",
        type: "denied",
      };
};

const publishPolicy = attendedWritePolicy(
  "Unattended runs cannot publish without an authorized delivery handoff."
);

/**
 * Direct-session publication. Adds the intake-only gate on top of the shared
 * write ladder: an intake-only channel cannot ship at all, and otherwise
 * trusted callers and schedule turns publish without a card while an
 * untrusted attended caller parks on one.
 */
export const deliveryPolicy = (ctx: ApprovalContext): ApprovalStatus => {
  const intake = intakeOnlyPolicy(ctx);
  return intake === "not-applicable" ? publishPolicy(ctx) : intake;
};

/**
 * Connection-wide policy for MCP servers whose writes must not run
 * unattended, whether the run is a factory turn or a schedule dispatching
 * under a real user (see {@link isUnattended}).
 *
 * @remarks
 * eve hands connection approval predicates the qualified tool name
 * (`<connection>__<tool>`), so matching is by suffix, never bare equality.
 * With no `writeTools` list, every tool on the connection counts as a
 * write, which is default-deny: a connection that an unattended run must
 * still read from names its reads at the call site rather than trying to
 * enumerate every write the server might grow. Attended sessions stay
 * ungated for ordinary shared configuration, these servers' writes are
 * app-scoped and reversible.
 */
export function denyUnattendedWrites(
  surface: string,
  writeTools?: readonly string[]
) {
  return (ctx: ApprovalContext): ApprovalStatus => {
    const isWrite =
      !writeTools ||
      writeTools.some(
        (tool) => ctx.toolName === tool || ctx.toolName.endsWith(`__${tool}`)
      );
    if (isWrite && isUnattended(ctx.session.auth.current)) {
      return {
        reason: `Unattended runs do not write to ${surface}.`,
        type: "denied",
      };
    }
    return "not-applicable";
  };
}

/**
 * Delivery requested from an intake-only channel.
 *
 * @remarks
 * Denied rather than parked: nobody in an intake-only channel is authorized
 * to ship code, so an approval card would only route the decision to the
 * wrong person, and a station running in task mode cannot park at all.
 * Everything short of delivery stays available, reading and investigating a
 * repository included, so a follow-up question in the thread still gets a
 * real answer. The denial reason is what the model relays back and acts on.
 */
export const intakeOnlyPolicy = (ctx: ApprovalContext): ApprovalStatus =>
  isIntakeOnly(ctx.session.auth.current)
    ? {
        reason:
          "This channel is intake-only. Investigate and answer here, but file the change as a Linear issue for triage instead of delivering it.",
        type: "denied",
      }
    : "not-applicable";

/**
 * Marking a pull request ready for review, which `updatePullRequest` performs
 * by sending `draft: false`.
 *
 * @remarks
 * Denied rather than parked, for the same reason delivery no longer parks: an
 * approval card cannot be answered from Slack, and a Linear agent session runs
 * with nobody watching for one, so a card there is a session that never
 * finishes. A denial reaches the model as a reason it can relay and work
 * around, which keeps the run moving.
 *
 * Only the readiness transition is gated. Editing a title, body, base branch,
 * or open and closed state stays ungated, as does converting a pull request
 * back to a draft, because none of those present work as reviewable.
 */
export const pullRequestReadinessPolicy = (
  ctx: ApprovalContext
): ApprovalStatus =>
  (ctx.toolInput as { draft?: unknown } | undefined)?.draft === false
    ? {
        reason:
          "Marking a pull request ready for review needs the user to ask for it. Open or update the pull request, say it is ready, and leave the transition to them.",
        type: "denied",
      }
    : "not-applicable";

/**
 * Deleting the calling user's own saved preferences.
 *
 * @remarks
 * The tool derives its Blob key from the framework-resolved principal, so a
 * session can only ever clear its own user's document, and an attended user
 * asking for it in the session is the authorization. An unattended turn has
 * no such request behind it: schedules dispatch under a real user principal
 * and read attacker-writable tracker content, so injected text could reach
 * this tool and delete that user's preferences.
 *
 * Denied rather than parked, like every other gate here. A card cannot be
 * answered from Slack, and an unattended run has nobody to answer one at all.
 */
export const userPreferencesDeletionPolicy = (
  ctx: ApprovalContext
): ApprovalStatus =>
  isUnattended(ctx.session.auth.current)
    ? {
        reason:
          "Unattended runs may not delete saved preferences. Only the signed-in user can ask for that, in their own session.",
        type: "denied",
      }
    : "not-applicable";
