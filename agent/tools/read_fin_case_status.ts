import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readFinCaseStatusForSession } from "#lib/executor/dispatch.js";
import { customerCaseStatus } from "#lib/fin-case.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";

const NO_CASE =
  "No ticket is associated with this conversation, so there is no team status to report.";
const UNAVAILABLE =
  "The current status of this report could not be checked. Do not describe it as resolved or as unresolved.";

const tool = defineTool({
  description:
    "Report what the team has done with the ticket for this conversation. It takes no arguments: the conversation comes from the immutable session. It answers with a customer-safe status sentence, or says no ticket is associated with this conversation. It never returns a ticket identifier or a link.",
  async execute(_input, ctx) {
    if (!isFinInvestigation(ctx.session.auth.initiator)) {
      return { message: UNAVAILABLE };
    }
    try {
      const found = await readFinCaseStatusForSession(ctx);
      if (!found) {
        return { message: NO_CASE };
      }
      return {
        checked_at: found.checked_at,
        message: customerCaseStatus[found.status] ?? UNAVAILABLE,
        status: found.status,
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return { message: UNAVAILABLE };
    }
  },
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({
    checked_at: z.string().optional(),
    message: z.string(),
    status: z.string().optional(),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? tool : null,
  },
});
