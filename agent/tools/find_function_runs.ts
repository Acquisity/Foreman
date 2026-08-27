import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  findFunctionRuns,
  findFunctionRunsResultSchema,
  RUN_STATUSES,
} from "#lib/inngest-api.js";
import { inngestAuth } from "#lib/inngest-api-auth.js";

export default defineTool({
  description:
    "Inngest background work: the newest runs of one function (by its slug from the code path) with the given status in the window, and the step trace of the newest one. " +
    "Omit functionId to list matching runs across every function, then narrow to the slug the code path names. Default: failed runs in the last 24 hours. " +
    "Read latestTrace.steps for the step that broke; error text is bounded and redacted. truncated true means more runs matched than the 20 returned. traceError means the runs were listed but the newest run's trace could not be read; error means the run list itself could not be read.",
  async execute(input, ctx) {
    let token: string;
    try {
      ({ token } = await ctx.getToken(inngestAuth));
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error: `Inngest credential unavailable: ${error instanceof Error ? error.message : "token request failed"}`,
        latestTrace: null,
        runs: [],
        truncated: false,
      };
    }
    return findFunctionRuns(
      token,
      {
        functionId: input.functionId,
        sinceHours: input.sinceHours ?? 24,
        status: input.status ?? "Failed",
      },
      { signal: ctx.abortSignal }
    );
  },
  inputSchema: z.object({
    functionId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._/-]{0,119}$/u)
      .optional()
      .describe(
        "The Inngest function id from the code path, such as ads.google.sync-workspace-insights."
      ),
    sinceHours: z.number().int().min(1).max(168).optional(),
    status: z.enum(RUN_STATUSES).optional(),
  }),
  outputSchema: findFunctionRunsResultSchema,
});
