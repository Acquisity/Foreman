import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  aiSdrWeeklyReportResultSchema,
  readAiSdrWeeklyReport,
} from "#lib/ai-sdr-weekly-report.js";
import { planetscaleAuth } from "#lib/constants.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
} from "#lib/planetscale.js";

export default defineTool({
  description:
    "Read the complete weekly AI SDR performance report from fixed production queries. It chooses the latest complete Monday-to-Friday window, compares it with the prior week and four weeks earlier, counts only scheduled non-deleted appointments whose origin is AI SDR, and returns deterministic volume, conversion, campaign-type, and lifecycle metrics. Call once with no input.",
  async execute(_input, ctx) {
    const { token } = await ctx.getToken(planetscaleAuth);
    return readAiSdrWeeklyReport(new Date(), async (query) => {
      try {
        return await callPlanetscaleReadQuery(token, {
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        });
      } catch (error) {
        if (
          error instanceof PlanetscaleHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          ctx.requireAuth(planetscaleAuth);
        }
        throw error;
      }
    });
  },
  inputSchema: z.object({}),
  outputSchema: aiSdrWeeklyReportResultSchema,
});
