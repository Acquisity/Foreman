import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { FIN_CASE_TOOL as TICKET_TOOL } from "./fin-case.js";
import { ticketLinkedModel } from "./ticket-link-model.js";

/** Evidence reads are free until this many results; then only the decision is left. */
const FIN_EVIDENCE_STEPS = 8;

/**
 * The ticket decision is mechanical, not a prompt instruction: while the tool
 * is offered and the turn holds no result from it, a tool call is required.
 * Every other offered tool also satisfies "required", so the constraint narrows
 * to the ticket tool once the evidence budget is spent and the turn can finish.
 */
export const finInvestigationMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams({ params }) {
    const results = params.prompt.flatMap((message) =>
      message.role === "tool" ? message.content : []
    );
    const undecided =
      params.tools?.some((tool) => tool.name === TICKET_TOOL) &&
      !results.some(
        (part) => part.type === "tool-result" && part.toolName === TICKET_TOOL
      );
    if (!undecided) {
      return Promise.resolve(params);
    }
    return Promise.resolve({
      ...params,
      toolChoice:
        results.length < FIN_EVIDENCE_STEPS
          ? { type: "required" as const }
          : { toolName: TICKET_TOOL, type: "tool" as const },
    });
  },
};

export const finInvestigationModel = (id: string) =>
  wrapLanguageModel({
    middleware: finInvestigationMiddleware,
    model: ticketLinkedModel(id),
  });
