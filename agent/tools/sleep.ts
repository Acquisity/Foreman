import { defineTool } from "eve/tools";
import { sleep } from "eve/tools/sleep";
import { z } from "zod";

/**
 * Enables eve's durable `sleep` tool with a bounded maximum wait.
 *
 * @remarks
 * A bare re-export of `sleep()` exposes an effectively unbounded wait: the
 * upstream schema caps `seconds` at `(2**53 - 1) / 1000`, so a model could
 * park a turn for an arbitrary length of time. This repository removed
 * `ask_question` for exactly that reason: a parked turn on Slack can never be
 * answered, and `sleep` can park a turn the same way. Capping the wait keeps
 * the tool useful for short polling (the review-bot loop sleeps 60 seconds at
 * a time) without letting a turn stall indefinitely.
 */

const MAX_SLEEP_SECONDS = 600;

const base = sleep();

export default defineTool({
  description: `${base.description} The wait is capped at ${MAX_SLEEP_SECONDS} seconds.`,
  execute: base.execute,
  inputSchema: z.strictObject({
    seconds: z
      .number()
      .positive()
      .max(MAX_SLEEP_SECONDS)
      .describe(`How long to wait, in seconds, up to ${MAX_SLEEP_SECONDS}.`),
  }),
  outputSchema: base.outputSchema,
});
