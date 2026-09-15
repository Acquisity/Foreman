import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/tools/sleep";
import { z } from "zod";

/**
 * Pauses before polling an external system after a known propagation delay.
 *
 * @remarks
 * A bare re-export of `sleep()` exposes both an effectively unbounded wait and
 * a generic model-visible tool that can be mistaken for delegated-task
 * polling. Delegated task lifecycle events arrive in later turns, so keeping
 * the current turn alive by sleeping prevents the root from receiving them.
 * The narrower name and description preserve bounded external-state polling
 * for the review-bot loop without advertising a generic wait primitive.
 */

const MAX_WAIT_SECONDS = 600;

const base = sleep();

export default defineWorkflowTool({
  ...base,
  description: `Pause before polling an external system again after a known propagation delay. Never use this after delegating to vision, critic, or a native agent; end the current turn so eve can deliver the task lifecycle event. The wait is capped at ${MAX_WAIT_SECONDS} seconds.`,
  inputSchema: z.strictObject({
    seconds: z
      .number()
      .positive()
      .max(MAX_WAIT_SECONDS)
      .describe(`How long to wait, in seconds, up to ${MAX_WAIT_SECONDS}.`),
  }),
});
