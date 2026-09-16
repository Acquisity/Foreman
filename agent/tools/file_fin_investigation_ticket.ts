import { defineDynamic, defineTool } from "eve/tools";
import { fileFinInvestigationCase } from "#lib/executor/dispatch.js";
import { finCaseDecision, finCaseOutcome } from "#lib/fin-case.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";

const tool = defineTool({
  description:
    "Record the final ticket decision for this investigation. Use not-needed for an answered question with no follow-up. Use file for a warranted, evidence-backed report, with symptoms, findings, uncertainty and next step in summary and a short customer-safe subject in customerSummary. Choose the established product project and area owner; Support goes to Aaron Fraga. A suspected issue is Not settled, never a verified Bug. The server verifies source, routing and documentation and reconciles uncertain writes. Repeated calls reuse the saved decision and never create a replacement ticket.",
  async execute(input, ctx) {
    if (!isFinInvestigation(ctx.session.auth.initiator)) {
      return {
        message: "This operation requires a verified investigation.",
        outcome: "failed" as const,
      };
    }
    try {
      return await fileFinInvestigationCase(ctx, input);
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        message:
          "The ticket outcome could not be confirmed. Do not create a replacement.",
        outcome: "failed" as const,
      };
    }
  },
  inputSchema: finCaseDecision,
  outputSchema: finCaseOutcome,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? tool : null,
  },
});
