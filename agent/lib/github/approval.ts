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
 * Rebuilding the warm repository snapshot: a several-minute sandbox build
 * that costs real compute, so it follows the same ladder as the other
 * shared-state writes rather than running on anyone's say-so.
 */
export const warmSnapshotPolicy = attendedWritePolicy(
  "Unattended runs may not rebuild the warm repository snapshot."
);

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
