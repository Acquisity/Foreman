import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { createFinInvestigationTicket } from "#lib/executor/dispatch.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";
import {
  confirmedIssue,
  formatCustomerReport,
} from "#lib/linear-ticket-report.js";

const tool = defineTool({
  description:
    "File one bounded internal Linear ticket for this verified customer investigation. The team, assignee, conversation and workspace scope are taken from the immutable session, never from this input. Use only when a ticket is warranted; all other Linear operations remain unavailable.",
  async execute(input, ctx) {
    if (!isFinInvestigation(ctx.session.auth.initiator)) {
      return {
        error:
          "This operation is available only to a verified Fin investigation.",
      };
    }
    try {
      const result = await createFinInvestigationTicket(ctx, {
        report: formatCustomerReport(input.summary),
        title: input.title,
      });
      if (!result.ok) {
        return { error: "Linear did not accept the ticket." };
      }
      try {
        return confirmedIssue(result.data);
      } catch {
        return {
          error:
            "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
        };
      }
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error:
          "The ticket outcome could not be confirmed. Do not retry automatically.",
      };
    }
  },
  inputSchema: z.strictObject({
    summary: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(160),
  }),
  outputSchema: z.union([
    z.object({ identifier: z.string(), url: z.string() }),
    z.object({ error: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? tool : null,
  },
});
