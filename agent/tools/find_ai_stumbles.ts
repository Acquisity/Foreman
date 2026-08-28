import { defineTool } from "eve/tools";
import { z } from "zod";
import { McpHttpError } from "#lib/mcp-call.js";
import {
  findAiStumbles,
  findAiStumblesResultSchema,
} from "#lib/raindrop-api.js";
import { raindropAuth } from "#lib/raindrop-api-auth.js";

export default defineTool({
  description:
    "Raindrop AI observability: the one-off failure modes (stumbles) Raindrop flagged in the product's AI interactions, newest first, 50 per page. " +
    "Indexed by symptom and time, never by customer: pass the behavior in the product's own words as query, or omit it to list every stumble in the window. Default: the last 24 hours. " +
    "Each stumble carries the failing interaction's time (eventAt) and Raindrop's tags. Frame findings as of lastRunAt; Raindrop scans every cadenceMinutes, not live. hasMore true means call again with page + 1. error means the search could not run.",
  async execute(input, ctx) {
    let token: string;
    try {
      ({ token } = await ctx.getToken(raindropAuth));
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        cadenceMinutes: null,
        error: `Raindrop credential unavailable: ${error instanceof Error ? error.message : "token request failed"}`,
        hasMore: false,
        lastRunAt: null,
        page: input.page ?? 1,
        stumbles: [],
      };
    }
    try {
      return await findAiStumbles(
        token,
        {
          page: input.page ?? 1,
          query: input.query,
          sinceHours: input.sinceHours ?? 24,
        },
        { signal: ctx.abortSignal }
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      // A key rotated or revoked surfaces as 401/403; re-challenge so eve
      // evicts the dead bearer instead of handing the model a dead-token error.
      if (
        error instanceof McpHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        ctx.requireAuth(raindropAuth);
      }
      return {
        cadenceMinutes: null,
        error:
          error instanceof Error ? error.message : "Raindrop search failed.",
        hasMore: false,
        lastRunAt: null,
        page: input.page ?? 1,
        stumbles: [],
      };
    }
  },
  inputSchema: z.object({
    page: z.number().int().min(1).max(50).optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Case-insensitive text matched against the stumble's title, subtitle, and description, such as 'meeting time' or 'wrong company name'."
      ),
    sinceHours: z.number().int().min(1).max(720).optional(),
  }),
  outputSchema: findAiStumblesResultSchema,
});
