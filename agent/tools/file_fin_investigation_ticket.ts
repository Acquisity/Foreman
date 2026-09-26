import { defineDynamic, defineTool } from "eve/tools";
import { fileFinInvestigationCase } from "#lib/executor/dispatch.js";
import {
  finCaseDecision,
  finCaseFailed,
  finCaseOutcome,
} from "#lib/fin-case.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";

export const finCaseTicketTool = defineTool({
  description:
    "Record the ticket decision for this verified customer investigation. The team, workspace and Intercom conversation come from the immutable session, never from this input. Report one of four outcomes: not-needed when no ticket is warranted, already-tracked when this conversation already has a ticket, newly-created when one was opened now, and failed when the outcome could not be verified. The conversation itself is the key, so calling this again never creates a replacement ticket.",
  async execute(input, ctx) {
    if (!isFinInvestigation(ctx.session.auth.initiator)) {
      return {
        message:
          "This operation is available only to a verified Fin investigation.",
        outcome: "failed" as const,
      };
    }
    try {
      return await fileFinInvestigationCase(ctx, input);
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return finCaseFailed;
    }
  },
  inputSchema: finCaseDecision,
  outputSchema: finCaseOutcome,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? finCaseTicketTool : null,
  },
});
