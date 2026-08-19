import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import {
  isAutonomous,
  isIntakeOnly,
  isScheduleAppAuth,
  isTrusted,
} from "../trust.js";

/**
 * Policy factory for writes to shared configuration every future run
 * inherits (repository knowledge and live model overrides).
 *
 * @remarks
 * Reads are always allowed and never routed here; these policies gate writes
 * only. Because such a write becomes context or behavior for every later
 * run, an unattended run is denied rather than parked (nobody is watching,
 * and a labeled issue's body is untrusted input that must not be able to
 * poison shared state). Trusted callers and schedule turns write without a
 * card; every other human caller, the dev TUI included, parks on one. The
 * denial reason is per-surface so a relayed refusal names the right feature.
 */
function sharedConfigWritePolicy(unattendedReason: string) {
  return (ctx: ApprovalContext): ApprovalStatus => {
    const auth = ctx.session.auth.current;
    if (isAutonomous(auth)) {
      return { reason: unattendedReason, type: "denied" };
    }
    if (isTrusted(auth) || isScheduleAppAuth(auth)) {
      return "not-applicable";
    }
    return "user-approval";
  };
}

/**
 * Verified repository knowledge that can feed future runs for that repository.
 */
export const repositoryKnowledgePolicy = sharedConfigWritePolicy(
  "Unattended runs may read repository knowledge but not write to it."
);

/**
 * The live model overrides: which model each factory agent runs on, applied
 * to every session that starts after the change.
 */
export const modelSwapPolicy = sharedConfigWritePolicy(
  "Unattended factory runs may not change the models the factory runs on."
);

/** Direct-session publication requires an explicit user approval card. */
export const deliveryPolicy = (ctx: ApprovalContext): ApprovalStatus => {
  if (isAutonomous(ctx.session.auth.current)) {
    return {
      reason:
        "Unattended runs cannot publish without an authorized delivery handoff.",
      type: "denied",
    };
  }
  return "user-approval";
};

/**
 * Connection-wide policy for MCP servers whose writes must not run
 * unattended.
 *
 * @remarks
 * eve hands connection approval predicates the qualified tool name
 * (`<connection>__<tool>`), so matching is by suffix, never bare equality.
 * With no `writeTools` list, every tool on the connection counts as a
 * write. Attended sessions stay ungated for ordinary shared configuration,
 * these servers' writes are app-scoped and reversible.
 */
export function denyAutonomousWrites(
  surface: string,
  writeTools?: readonly string[]
) {
  return (ctx: ApprovalContext): ApprovalStatus => {
    const isWrite =
      !writeTools ||
      writeTools.some(
        (tool) => ctx.toolName === tool || ctx.toolName.endsWith(`__${tool}`)
      );
    if (isWrite && isAutonomous(ctx.session.auth.current)) {
      return {
        reason: `Unattended factory runs do not write to ${surface}.`,
        type: "denied",
      };
    }
    return "not-applicable";
  };
}

/**
 * Repository work requested from an intake-only channel.
 *
 * @remarks
 * Denied rather than parked: nobody in an intake-only channel is authorized
 * to action code changes, so an approval card would only route the decision
 * to the wrong person. Conversation, reads outside a repository workspace,
 * and filing the request to Linear all stay available; the denial reason is
 * what the model relays back and acts on.
 */
export const intakeOnlyPolicy = (ctx: ApprovalContext): ApprovalStatus =>
  isIntakeOnly(ctx.session.auth.current)
    ? {
        reason:
          "This channel is intake-only. File the request as a Linear issue for triage instead of preparing a repository.",
        type: "denied",
      }
    : "not-applicable";
