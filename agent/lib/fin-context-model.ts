import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { ticketLinkedModel } from "./ticket-link-model.js";

const TOOL_BLOCKED = "Fin context Preview cannot execute tools.";

// This identity-only Preview slice cannot use Foreman's unscoped tools. Enforce
// this before the AI SDK can dispatch model output, not in an Eve event hook.
export const finContextMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams({ params }) {
    return Promise.resolve({
      ...params,
      toolChoice: { type: "none" },
      tools: [],
    });
  },
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    if (
      result.content.some((part) => part.type.startsWith("tool-")) ||
      result.finishReason.unified === "tool-calls"
    ) {
      throw new Error(TOOL_BLOCKED);
    }
    return result;
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (
              part.type.startsWith("tool-") ||
              (part.type === "finish" &&
                part.finishReason.unified === "tool-calls")
            ) {
              throw new Error(TOOL_BLOCKED);
            }
            controller.enqueue(part);
          },
        })
      ),
    };
  },
};

export const finContextModel = (id: string) =>
  wrapLanguageModel({
    middleware: finContextMiddleware,
    model: ticketLinkedModel(id),
  });
