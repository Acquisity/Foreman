import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { ticketLinkedModel } from "./ticket-link-model.js";

const ALLOWED_TOOLS = new Set([
  "file_fin_investigation_ticket",
  "read_fin_outreach_evidence",
]);
const BLOCKED = "Customer investigation capability is unavailable.";

const namedTool = (part: { toolName?: unknown }) =>
  typeof part.toolName === "string" && ALLOWED_TOOLS.has(part.toolName);

function assertAllowedStreamPart(
  part: { id?: string; toolCallId?: string; toolName?: unknown; type: string },
  allowedCalls: Set<string>
) {
  if (part.type === "tool-input-start" || part.type === "tool-call") {
    if (!namedTool(part)) {
      throw new Error(BLOCKED);
    }
    allowedCalls.add(
      part.type === "tool-call" ? String(part.toolCallId) : String(part.id)
    );
    return;
  }
  if (part.type === "tool-input-delta" || part.type === "tool-input-end") {
    if (!allowedCalls.has(String(part.id))) {
      throw new Error(BLOCKED);
    }
    return;
  }
  if (
    (part.type === "tool-result" || part.type === "tool-approval-request") &&
    !allowedCalls.has(String(part.toolCallId))
  ) {
    throw new Error(BLOCKED);
  }
}

/**
 * Keep the customer lane to authored scoped evidence and its bounded ticket write.
 * Native delegation is background-only, so this task-mode route cannot safely expose
 * it until the asynchronous result lifecycle owned by ENG-13766 is implemented.
 * The output checks also reject an adversarial model call that was not advertised.
 */
export const finInvestigationMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams({ params }) {
    const { toolChoice: requestedToolChoice } = params;
    const tools = params.tools?.filter(
      (tool) => typeof tool.name === "string" && ALLOWED_TOOLS.has(tool.name)
    );
    // A decision can record not-needed or failed without creating an issue.
    // Require tool use until that decision has returned, rather than trusting
    // a prose instruction that the model can skip when it answers directly.
    const needsDecision =
      tools?.some((tool) => tool.name === "file_fin_investigation_ticket") &&
      !params.prompt.some(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) =>
              part.type === "tool-result" &&
              part.toolName === "file_fin_investigation_ticket"
          )
      );
    const allowedChoice =
      requestedToolChoice?.type === "tool" &&
      !ALLOWED_TOOLS.has(requestedToolChoice.toolName)
        ? { type: "auto" as const }
        : requestedToolChoice;
    const toolChoice = needsDecision
      ? { type: "required" as const }
      : allowedChoice;
    return Promise.resolve({ ...params, toolChoice, tools });
  },
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    let sawAllowedCall = false;
    for (const part of result.content) {
      if (part.type === "tool-call") {
        if (!namedTool(part)) {
          throw new Error(BLOCKED);
        }
        sawAllowedCall = true;
      } else if (part.type.startsWith("tool-")) {
        throw new Error(BLOCKED);
      }
    }
    if (result.finishReason.unified === "tool-calls" && !sawAllowedCall) {
      throw new Error(BLOCKED);
    }
    return result;
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    const allowedCalls = new Set<string>();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            assertAllowedStreamPart(part, allowedCalls);
            if (
              part.type === "finish" &&
              part.finishReason.unified === "tool-calls" &&
              allowedCalls.size === 0
            ) {
              throw new Error(BLOCKED);
            }
            controller.enqueue(part);
          },
        })
      ),
    };
  },
};

export const finInvestigationModel = (id: string) =>
  wrapLanguageModel({
    middleware: finInvestigationMiddleware,
    model: ticketLinkedModel(id),
  });
