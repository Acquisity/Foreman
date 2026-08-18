import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { isAutonomous, isScheduleAppAuth, isTrusted } from "../trust.js";

/**
 * Policy factory for writes to shared configuration every future run
 * inherits (the factory brain, the live model overrides).
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
 * The shared factory brain: durable notes about the target repository that
 * feed into every future run.
 */
export const factoryBrainPolicy = sharedConfigWritePolicy(
  "Unattended factory runs may read the factory brain but not write to it."
);

/**
 * The live model overrides: which model each factory agent runs on, applied
 * to every session that starts after the change.
 */
export const modelSwapPolicy = sharedConfigWritePolicy(
  "Unattended factory runs may not change the models the factory runs on."
);

/**
 * Connection-wide policy for MCP servers whose writes must not run
 * unattended.
 *
 * @remarks
 * eve hands connection approval predicates the qualified tool name
 * (`<connection>__<tool>`), so matching is by suffix, never bare equality.
 * With no `writeTools` list, every tool on the connection counts as a
 * write. Attended sessions stay ungated: unlike factory-brain writes,
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
